// The short account menu on the kit Menu: head, My account (G K), Appearance, Language and
// Sign out; no color scheme and no start page; the head is no menu item and names the real roles;
// Sign out is blocked with its reason while the console saves. React SSR, no browser, no server.
import {mock} from '../../support/register.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import * as radix from 'radix-ui';
import {renderToStaticMarkup} from 'react-dom/server';
const inline=({children})=>children;
mock('radix-ui',{...radix,DropdownMenu:{...radix.DropdownMenu,Portal:inline}});
const h=React.createElement;
const shell=await import('../../../ui/shell/shell.tsx');
const {menuEntrySelect}=await import('../../../ui/kit/kit.tsx');
const {LocaleProvider}=await import('../../../ui/base/locale.tsx');
const {translate}=await import('../../../lib/i18n/translate.ts');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};

const viewer={id:'u1',label:'ada@example.test',username:'ada',displayName:'Ada Lovelace',permissions:[],roles:['Auditors','Operators']};
const tOf=locale=>(key,params)=>translate(locale,key,params);
const calls=[];
const build=(extra={},locale='en')=>shell.accountMenuEntries({viewer,saving:false,theme:'dark',setTheme:value=>calls.push(['theme',value]),locale,setLocale:value=>calls.push(['locale',value]),t:tOf(locale),onAccount:()=>calls.push(['account']),onSignOut:()=>calls.push(['signOut']),...extra});

// ---- Entries in order ----
const entries=build();
check(entries.map(entry=>entry.id),['head','head-separator','account','account-separator','theme','theme-separator','language','language-separator','sign-out'],'head, My account, Appearance, Language, Sign out with separators');
ok(!entries.some(entry=>/scheme|start/i.test(entry.id)||/Color scheme|Start page/.test(entry.label??'')),'no Color scheme and no Start page entry');
const account=entries.find(entry=>entry.id==='account');
check([account.label,account.shortcut],['My account','G K'],'My account with the shortcut G K');
const theme=entries.find(entry=>entry.id==='theme'),language=entries.find(entry=>entry.id==='language');
check([theme.label,theme.value,theme.items.map(item=>item.label)],['Appearance','dark',['Light','Dark','Match system']],'the Appearance radio group');
check([language.label,language.value,language.items.map(item=>[item.label,item.lang])],['Language','en',[['English','en'],['Deutsch','de']]],'the Language radio group names each language in itself');
theme.onValueChange('light');language.onValueChange('de');account.onSelect();
check(calls.splice(0),[['theme','light'],['locale','de'],['account']],'the groups apply through the given setters; My account opens the page');

// ---- Rendered: the head is not a menu item, the radio groups and the shortcut ----
const menu=(props,locale='en')=>renderToStaticMarkup(h(LocaleProvider,{locale},h(shell.AccountMenu,{viewer,saving:false,onAccount(){},onSignOut(){},open:true,...props})));
let html=menu({});
const content=html.match(/<div[^>]*role="menu"[^>]*>/)[0];
ok(/class="sdx-menu sdx-account-menu"/.test(content),'the kit Menu keeps the account menu width class');
const head=html.slice(html.indexOf('<div class="sdx-menu-head">'),html.indexOf('</div></div></div>',html.indexOf('sdx-menu-head')));
ok(head.includes('<strong>Ada Lovelace</strong>')&&head.includes('<small>ada</small>')&&head.includes('Auditors, Operators'),'the head shows name, account detail and the role names');
ok(!/role="menuitem|tabindex/.test(head),'the head is no menu item and takes no focus');
ok(html.indexOf('sdx-menu-head')<html.indexOf('role="menuitem"'),'the head comes first');
check((html.match(/role="menuitemradio"/g)??[]).length,5,'Appearance (3) and Language (2) are radio items');
ok(/<div[^>]*role="menuitemradio"[^>]*lang="de"|lang="de"[^>]*role="menuitemradio"/.test(html),'Deutsch carries lang="de"');
ok(/My account<\/span><kbd class="sdx-kbd">G K<\/kbd>/.test(html),'My account shows G K');
ok(!/Color scheme|Start page|Farbschema|Startseite/.test(html),'neither Color scheme nor Start page renders');
ok(/aria-label="Account: Ada Lovelace"/.test(html),'the avatar button names the account');

// ---- The role line: 0, 1, 3 and 5 roles, en and de ----
const roles=['Auditors','Helpdesk','Operators','Owner','Readers'];
for(const [locale,none,more] of [['en','No role','Auditors, Helpdesk, Operators and 2 more'],['de','Keine Rolle','Auditors, Helpdesk, Operators und 2 weitere']]){
 const t=tOf(locale);
 check(shell.roleSummary([],t),none,`${locale}: no role`);
 check(shell.roleSummary(undefined,t),none,`${locale}: roles missing`);
 check(shell.roleSummary(['Owner'],t),'Owner',`${locale}: one role`);
 check(shell.roleSummary(roles.slice(0,3),t),'Auditors, Helpdesk, Operators',`${locale}: three roles`);
 check(shell.roleSummary(roles,t),more,`${locale}: five roles`);
}
ok(menu({viewer:{...viewer,roles:[]}}).includes('No role'),'the rendered head says No role');
ok(menu({},'de').includes('Auditors, Operators')&&menu({viewer:{...viewer,roles:[]}},'de').includes('Keine Rolle'),'German head');

// ---- Sign out: blocked while saving, runs without a confirmation otherwise ----
const signOut=build({saving:true}).find(entry=>entry.id==='sign-out');
check(signOut.blocked,'Wait until the change is saved.','blocked with its reason while saving');
const event={prevented:false,preventDefault(){event.prevented=true;}};menuEntrySelect(signOut)(event);
ok(event.prevented&&!calls.length,'a blocked Sign out runs nothing and keeps the menu open');
const free=build().find(entry=>entry.id==='sign-out');
ok(free.blocked===undefined,'not blocked while nothing saves');
menuEntrySelect(free)({preventDefault(){}});check(calls.splice(0),[['signOut']],'Sign out runs signOutPortal at once');
html=menu({saving:true});
const item=html.match(/<div[^>]*role="menuitem"[^>]*>(?:(?!<\/div>).)*Sign out[\s\S]*?<\/div>/)[0];
ok(/aria-disabled="true"/.test(item)&&item.includes('Wait until the change is saved.')&&!/\sdisabled=""/.test(item),'the rendered Sign out is aria-disabled with its visible reason, no native disabled');

// ---- No raw radix menu in the shell and the preference modules ----
for(const file of ['ui/shell/shell.tsx','ui/shell/theme.tsx','ui/base/locale.tsx','ui/shell/color-scheme.tsx','ui/shell/start-page.tsx']){
 ok(!/import\s*\{[^}]*\bDropdownMenu\b[^}]*\}\s*from\s*'radix-ui'/.test(fs.readFileSync(file,'utf8')),file+' imports no DropdownMenu from radix-ui');
}
const modules=[await import('../../../ui/shell/theme.tsx'),await import('../../../ui/base/locale.tsx'),await import('../../../ui/shell/color-scheme.tsx'),await import('../../../ui/shell/start-page.tsx')];
for(const name of ['ThemeMenuGroup','LanguageMenuGroup','ColorSchemeMenu','ColorSchemeTrigger','ColorSchemeItems','StartPageMenuGroup'])ok(modules.every(module=>!(name in module)),name+' is gone');
ok(typeof modules[0].themeMenuEntry==='function'&&typeof modules[1].languageMenuEntry==='function','the builders return kit MenuRadioEntry objects');

console.log(`PASS account menu (${checks} checks): head with roles, My account (G K), Appearance and Language on the kit Menu, blocked Sign out while saving, no scheme or start page, no raw radix menu.`);
