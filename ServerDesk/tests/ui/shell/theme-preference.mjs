// Appearance preference and switch: cookie format, server-rendered
// <html data-theme>, the account menu group and the palette actions, plus the
// color scheme attributes and their cookie writer, and the density attribute (lib/density.ts) from its cookie.
import {mock} from '../../support/register.mjs';
import assert from 'node:assert/strict';
import {existsSync,readFileSync,readdirSync,statSync} from 'node:fs';
import path from 'node:path';
import React from 'react';
import * as radix from 'radix-ui';
import {renderToStaticMarkup} from '../../support/render-de.mjs';

let cookieValue,densityValue;
mock('radix-ui',{...radix,DropdownMenu:{...radix.DropdownMenu,Portal:({children})=>children}});
mock('next/headers',{cookies:async()=>({get:name=>name==='serverdesk-theme'&&cookieValue!==undefined?{name,value:cookieValue}:name==='serverdesk-density'&&densityValue!==undefined?{name,value:densityValue}:undefined}),headers:async()=>new Headers()});

const {themes,themeCookieName,parseTheme,themeCookie}=await import('../../../lib/theme.ts');
const {default:RootLayout}=await import('../../../app/layout.tsx');
const theme=await import('../../../ui/shell/theme.tsx');
const {Menu}=await import('../../../ui/kit/kit.tsx');
const lucide=await import('lucide-react');
const {topicFor}=await import('../../../ui/shell/help-panel.tsx');
// Theme texts are message keys; the German text comes from the catalog.
const {translate}=await import('../../../lib/i18n/translate.ts');
const de=key=>translate('de',key);
const read=file=>readFileSync(file,'utf8');

// Values, parsing and the cookie string.
assert.deepEqual([...themes],['light','dark','system']);
assert.equal(themeCookieName,'serverdesk-theme');
for(const value of themes)assert.equal(parseTheme(value),value);
// Without a valid cookie the console follows the operating system.
for(const value of [undefined,null,'','Dark','LIGHT','blue','dark; x',' dark',1])assert.equal(parseTheme(value),'system',`parseTheme(${JSON.stringify(value)})`);
assert.equal(themeCookie('dark',false),'serverdesk-theme=dark; Path=/; Max-Age=31536000; SameSite=Lax');
assert.equal(themeCookie('system',true),'serverdesk-theme=system; Path=/; Max-Age=31536000; SameSite=Lax; Secure');
for(const value of themes)for(const secure of [false,true])assert.doesNotMatch(themeCookie(value,secure),/httponly/i);

// The root layout renders data-theme from the cookie, without a script.
const layout=async value=>{cookieValue=value;return renderToStaticMarkup(await RootLayout({children:React.createElement('main',null,'Inhalt')}));};
for(const [value,expected] of [['dark','dark'],['system','system'],['light','light'],[undefined,'system'],['blue','system'],['Dark','system'],['','system'],['dark; x','system']]){
 const html=await layout(value);
 assert.match(html,new RegExp(`^<html lang="en" data-theme="${expected}" data-density="comfortable"(?: data-scheme-(?:light|dark)="[a-z-]+")*>`),`cookie ${JSON.stringify(value)} -> ${expected}`);
 assert.ok(!html.includes('<script'),'no inline script');
}
// The root layout renders data-density from the density cookie, comfortable without a valid one.
for(const [value,expected] of [['compact','compact'],['comfortable','comfortable'],[undefined,'comfortable'],['Compact','comfortable'],['dense','comfortable']]){
 densityValue=value;cookieValue='dark';
 const html=await layout('dark');
 assert.match(html,new RegExp(`^<html lang="en" data-theme="dark" data-density="${expected}"`),`density cookie ${JSON.stringify(value)} -> ${expected}`);
 assert.ok(!html.includes('<script'),'no inline script');
}
densityValue=undefined;

// Sign-out keeps the cookie. Nothing clears site data or names the theme cookie besides the theme modules.
const walk=dir=>!existsSync(dir)?[]:readdirSync(dir).flatMap(name=>{const file=path.posix.join(dir,name);return statSync(file).isDirectory()?walk(file):/\.(ts|tsx)$/.test(file)?[file]:[];});
const sources=[...walk('app'),...walk('lib'),...walk('ui'),'proxy.ts'];
const writesScheme=/dataset\.scheme(?:Light|Dark)\s*=|setAttribute\(\s*['"]data-scheme-|schemeCookie\(|serverdesk-scheme/;
for(const file of sources){
 const text=read(file);
 assert.doesNotMatch(text,/Clear-Site-Data/i,`${file} does not clear site data`);
 // Only ui/shell/theme.tsx writes data-theme or a cookie in the browser.
 if(file!=='ui/shell/theme.tsx'&&file!=='lib/theme.ts'){
  // The language, color scheme and density switches write their own cookie, never the theme.
  const writes=['ui/base/locale.tsx','ui/shell/color-scheme.tsx','ui/shell/density.tsx'].includes(file)?/dataset\.theme\s*=|setAttribute\(\s*['"]data-theme|themeCookie\(/:/dataset\.theme\s*=|setAttribute\(\s*['"]data-theme|document\.cookie\s*=|themeCookie\(/;
  assert.doesNotMatch(text,writes,`${file} does not write the theme`);
 }
 // Only ui/shell/color-scheme.tsx writes data-scheme-* or the scheme cookie.
 if(!['ui/shell/color-scheme.tsx','lib/color-schemes.ts'].includes(file))assert.doesNotMatch(text,writesScheme,`${file} does not write the color scheme`);
 // Only ui/shell/density.tsx writes data-density or the density cookie.
 if(!['ui/shell/density.tsx','lib/density.ts'].includes(file))assert.doesNotMatch(text,/dataset\.density\s*=|setAttribute\(\s*['"]data-density|densityCookie\(|serverdesk-density/,`${file} does not write the density`);
}
assert.match(read('ui/shell/density.tsx'),/dataset\.density=density/,'the density switch is the writer');
assert.match(read('ui/shell/color-scheme.tsx'),/dataset\.schemeLight=choice\.light/,'the scheme switch is the writer');

// The menu group in the account menu, order Hell/Dunkel/Wie System.
assert.equal(de(theme.themeHeading),'Darstellung');
assert.deepEqual(theme.themeOptions.map(option=>[option.theme,de(option.label),option.Icon]),[['light','Hell',lucide.Sun],['dark','Dunkel',lucide.Moon],['system','Wie System',lucide.Monitor]]);
const menu=renderToStaticMarkup(React.createElement(Menu,{label:'Konto',open:true,entries:[theme.themeMenuEntry('system',()=>{},key=>de(key))]}));
assert.ok(menu.includes('>Darstellung<'),'heading');
const radios=[...menu.matchAll(/<div[^>]*role="menuitemradio"[^>]*>.*?<span>([^<]+)<\/span>/g)];
assert.deepEqual(radios.map(match=>match[1]),['Hell','Dunkel','Wie System']);
for(const [html] of radios)assert.match(html,/class="sdx-menu-item"/);
assert.deepEqual(radios.map(([html])=>html.match(/aria-checked="(\w+)"/)[1]),['false','false','true'],'server snapshot shows the default "Wie System" as checked');
assert.equal((menu.match(/lucide-check/g)??[]).length,1,'only the active entry shows the check');
for(const icon of ['lucide-sun','lucide-moon','lucide-monitor'])assert.ok(menu.includes(icon),icon);
const shell=read('ui/shell/shell.tsx');
// The menu entries come from accountMenuEntries and their texts are message keys.
// Order: head, My account, appearance, language, sign out; the color scheme is in My account.
const order=['sdx-account-head','separator:true',"t('shell.myAccount')",'separator:true','themeMenuEntry(theme,setTheme,t)','separator:true','languageMenuEntry(locale,setLocale,t)','separator:true',"t('shell.signOut')"];
assert.doesNotMatch(shell,/ColorScheme|StartPage/,'no color scheme or start page in the account menu');
let at=shell.indexOf('export function accountMenuEntries');
for(const part of order){const next=shell.indexOf(part,at+1);assert.ok(next>at,`account menu: ${part} follows`);at=next;}

// The setter shows the theme at once and writes the cookie; a blocked cookie is ignored.
const fake=(protocol,cookieFails=false)=>{const target={document:{documentElement:{dataset:{}},written:[]},location:{protocol}};Object.defineProperty(target.document,'cookie',{set(value){if(cookieFails)throw new Error('blocked');target.document.written.push(value);},get(){return '';}});return target;};
let target=fake('https:');
theme.applyTheme('dark',target);
assert.equal(target.document.documentElement.dataset.theme,'dark');
assert.deepEqual(target.document.written,[themeCookie('dark',true)]);
assert.equal(theme.currentTheme(target),'dark');
target=fake('http:');
theme.applyTheme('system',target);
assert.deepEqual(target.document.written,['serverdesk-theme=system; Path=/; Max-Age=31536000; SameSite=Lax']);
target=fake('https:',true);
assert.doesNotThrow(()=>theme.applyTheme('light',target));
assert.equal(target.document.documentElement.dataset.theme,'light');
assert.equal(theme.currentTheme({document:{documentElement:{dataset:{theme:'nonsense'}}}}),'system');

// Three palette actions in "Aktionen" with the same effect.
const picked=[];
const items=theme.themePaletteItems(value=>picked.push(value),'de');
assert.deepEqual(items.map(item=>[item.group,item.label,item.keywords]),[['Aktionen','Helle Darstellung','theme darkmode dark light hell dunkel modus augenschonend'],['Aktionen','Dunkle Darstellung','theme darkmode dark light hell dunkel modus augenschonend'],['Aktionen','Darstellung wie System','theme darkmode dark light hell dunkel modus augenschonend']]);
assert.equal(new Set(items.map(item=>item.id)).size,3);
for(const item of items)item.run();
assert.deepEqual(picked,['light','dark','system']);
assert.match(read('ui/shell/console.tsx'),/\.\.\.themePaletteItems\(applyTheme,locale\)/,'the console palette lists the theme actions in the current language');
assert.doesNotMatch(read('ui/shell/console-shortcuts.ts'),/theme|darstellung/i,'no new shortcut');

// Third tip in "Mein Konto".
const account=topicFor({view:'account'},'de');
assert.equal(account.title,'Mein Konto');
assert.equal(account.tips.length,4,'the language tip follows this one');
// The tip names the Preferences card of this page.
assert.equal(account.tips[2],'Darstellung, Farbschema, Sprache und Startseite legst du auf dieser Seite unter „Einstellungen der Oberfläche“ fest.');

console.log('theme preference ok');
