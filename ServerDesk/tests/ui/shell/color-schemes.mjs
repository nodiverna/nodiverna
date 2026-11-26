// Color schemes: the scheme list, the cookie per mode, the server-rendered
// <html data-scheme-light data-scheme-dark>, the Preferences card of My account, the
// setter, the effective mode and the palette actions. Tokens and contrast are in
// tests/ui/styles/theme-tokens.mjs. The brand colors (docs/branding.md): the default for a missing or unknown
// cookie part, shown as Aurora while the portal has no brand scheme, and first with "(default)" once it has one.
import {mock} from '../../support/register.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from '../../support/render-de.mjs';

let cookieJar={};
mock('next/headers',{cookies:async()=>({get:name=>cookieJar[name]!==undefined?{name,value:cookieJar[name]}:undefined}),headers:async()=>new Headers()});

const schemes=await import('../../../lib/color-schemes.ts');
const {colorSchemes,defaultScheme,schemeCookieName,schemesFor,parseSchemeChoice,schemeCookie,chooseScheme}=schemes;
const {default:RootLayout}=await import('../../../app/layout.tsx');
const scheme=await import('../../../ui/shell/color-scheme.tsx');
const {topicFor}=await import('../../../ui/shell/help-panel.tsx');
const {translate}=await import('../../../lib/i18n/translate.ts');
const h=React.createElement;
const read=file=>readFileSync(file,'utf8');
const render=node=>renderToStaticMarkup(node);
const both=id=>({light:id,dark:id});
let checks=0;

// The list, its order and modes.
assert.deepEqual(colorSchemes.map(item=>[item.id,item.name,[...item.modes]]),[
 ['brand','scheme.brand',['light','dark']],
 ['aurora','scheme.aurora',['light','dark']],
 ['cyber-teal','scheme.cyberTeal',['light','dark']],
 ['inkberry','scheme.inkberry',['light','dark']],
 ['electric-violet','scheme.electricViolet',['light','dark']],
 ['ember','scheme.ember',['light']],
 ['prompt-blue','scheme.promptBlue',['dark']],
]);
// The default rule: an account without its own choice gets the brand colors.
assert.equal(defaultScheme,'brand');
assert.equal(schemeCookieName,'serverdesk-scheme');
assert.deepEqual(schemesFor('light').map(item=>item.id),['brand','aurora','cyber-teal','inkberry','electric-violet','ember']);
assert.deepEqual(schemesFor('dark').map(item=>item.id),['brand','aurora','cyber-teal','inkberry','electric-violet','prompt-blue']);
assert.deepEqual(schemesFor('light',{brand:false}).map(item=>item.id),['aurora','cyber-teal','inkberry','electric-violet','ember'],'without a brand scheme the lists leave brand out');
assert.deepEqual(schemesFor('dark',{brand:false}).map(item=>item.id),['aurora','cyber-teal','inkberry','electric-violet','prompt-blue']);
assert.doesNotMatch(read('lib/color-schemes.ts').replace(/\/\/[^\n]*/g,''),/#[0-9a-f]{3,8}\b|rgba?\(/i,'the list holds no color value');
checks+=7;

// Parsing per part and the cookie string: a missing cookie or a part that is not offered is the brand colors, an
// explicit choice (aurora.aurora included) stays.
for(const [value,expected] of [
 [undefined,both('brand')],[null,both('brand')],['',both('brand')],['garbage',both('brand')],['EMBER.x',both('brand')],['ember',both('brand')],
 ['prompt-blue.ember',both('brand')],['ember.inkberry',{light:'ember',dark:'inkberry'}],['a.b.c',both('brand')],['ember.prompt-blue',{light:'ember',dark:'prompt-blue'}],
 ['cyber-teal.x',{light:'cyber-teal',dark:'brand'}],['x.prompt-blue',{light:'brand',dark:'prompt-blue'}],['aurora.aurora',both('aurora')],[42,both('brand')],[' ember.inkberry',{light:'brand',dark:'inkberry'}],
 ['brand.brand',both('brand')],['brand.aurora',{light:'brand',dark:'aurora'}],
])assert.deepEqual(parseSchemeChoice(value),expected,`parseSchemeChoice(${JSON.stringify(value)})`);
assert.equal(schemeCookie({light:'ember',dark:'prompt-blue'},false),'serverdesk-scheme=ember.prompt-blue; Path=/; Max-Age=31536000; SameSite=Lax');
assert.equal(schemeCookie(both('aurora'),true),'serverdesk-scheme=aurora.aurora; Path=/; Max-Age=31536000; SameSite=Lax; Secure');
for(const secure of [false,true])assert.doesNotMatch(schemeCookie({light:'inkberry',dark:'cyber-teal'},secure),/httponly/i);
checks+=4;

// A pick applies to the other mode too where the scheme is offered.
let choice=both('aurora');
choice=chooseScheme(choice,'ember','light');assert.deepEqual(choice,{light:'ember',dark:'aurora'});
choice=chooseScheme(choice,'prompt-blue','dark');assert.deepEqual(choice,{light:'ember',dark:'prompt-blue'});
choice=chooseScheme(choice,'cyber-teal','dark');assert.deepEqual(choice,{light:'cyber-teal',dark:'cyber-teal'});
const start={light:'inkberry',dark:'electric-violet'};
assert.equal(chooseScheme(start,'ember','dark'),start,'an id not offered in the mode returns the choice unchanged');
assert.equal(chooseScheme(start,'prompt-blue','light'),start);
checks+=4;

// The root layout renders both scheme attributes from the cookie, without a script.
const layout=async cookies=>{cookieJar=cookies;return render(await RootLayout({children:h('main',null,'Inhalt')}));};
for(const [cookies,light,dark] of [
 [{'serverdesk-scheme':'ember.prompt-blue'},'ember','prompt-blue'],
 [{'serverdesk-scheme':'inkberry.inkberry','serverdesk-theme':'dark'},'inkberry','inkberry'],
 [{},'brand','brand'],
 [{'serverdesk-scheme':'garbage'},'brand','brand'],
 [{'serverdesk-scheme':'prompt-blue.ember','serverdesk-theme':'system'},'brand','brand'],
 [{'serverdesk-scheme':'aurora.aurora'},'aurora','aurora'],
]){
 const html=await layout(cookies);
 assert.match(html,new RegExp(`^<html lang="en" data-theme="(?:light|dark|system)" data-density="comfortable" data-scheme-light="${light}" data-scheme-dark="${dark}">`),JSON.stringify(cookies));
 assert.ok(!html.includes('<script'),'no inline script');
 // The brand stylesheet is linked in the head of every page, so the first paint has the brand colors.
 assert.ok(html.includes('<head><link rel="stylesheet" href="/api/branding/scheme" data-brand-scheme=""/></head>'),'the brand scheme stylesheet in the head');
}
checks+=3;

// Sign-out keeps the cookie; theme-preference.mjs checks that nothing clears site data.
const sources=['ui/shell/console.tsx','ui/shell/shell.tsx','ui/shell/theme.tsx'].map(read).join('\n');
assert.doesNotMatch(sources,/serverdesk-scheme|schemeCookie\(/,'sign-out and the theme switch leave the scheme cookie alone');
checks+=1;

// The scheme choice lives in the Preferences card of My account (tests/ui/account/account-preferences.mjs renders it):
// a kit Select with the schemes of the effective mode, the mode hint and a swatch of the active scheme.
assert.deepEqual(scheme.schemeOptions('light',{light:'aurora',dark:'prompt-blue'}).map(option=>[option.id,option.checked]),[['aurora',true],['cyber-teal',false],['inkberry',false],['electric-violet',false],['ember',false]]);
// Without a brand scheme the default "brand" shows as Aurora; with one it leads as "Brand colors (default)".
assert.deepEqual(scheme.shownSchemeChoice(both('brand'),false),both('aurora'),'brand shows as aurora without a brand scheme');
assert.deepEqual(scheme.shownSchemeChoice({light:'brand',dark:'ember'},true),{light:'brand',dark:'ember'},'with one it stays');
assert.deepEqual(scheme.shownSchemeChoice({light:'inkberry',dark:'brand'},false),{light:'inkberry',dark:'aurora'});
assert.deepEqual(scheme.schemeOptions('dark',both('brand')).map(option=>[option.id,option.name,option.checked]),[['aurora','scheme.aurora',true],['cyber-teal','scheme.cyberTeal',false],['inkberry','scheme.inkberry',false],['electric-violet','scheme.electricViolet',false],['prompt-blue','scheme.promptBlue',false]],'no brand scheme: Aurora (default) is checked');
assert.deepEqual(scheme.schemeOptions('dark',both('brand'),true).map(option=>[option.id,option.name,option.checked]).slice(0,2),[['brand','scheme.brandDefault',true],['aurora','scheme.auroraPlain',false]],'with a brand scheme: Brand colors (default) first, then Aurora');
assert.deepEqual(['en','de'].map(locale=>[translate(locale,'scheme.brand'),translate(locale,'scheme.brandDefault'),translate(locale,'scheme.auroraPlain'),translate(locale,'scheme.aurora')]),[['Brand colors','Brand colors (default)','Aurora','Aurora (default)'],['Markenfarben','Markenfarben (Standard)','Aurora','Aurora (Standard)']],'the labels');
assert.deepEqual([translate('de',scheme.schemeModeHeadings.light),translate('de',scheme.schemeModeHeadings.dark),translate('en',scheme.schemeModeHeadings.dark)],['Für die helle Darstellung','Für die dunkle Darstellung','For the dark appearance'],'the mode hints');
assert.deepEqual([translate('en','scheme.aurora'),translate('en','scheme.promptBlue')].every(Boolean),true,'the scheme names are catalog texts');
const preferences=read('ui/account/account-preferences.tsx');
assert.ok(preferences.includes('<span className="sdx-scheme-swatch" data-scheme-swatch={choice[mode]} aria-hidden="true"/>')&&preferences.includes('const schemes=schemesFor(mode,{brand:brandScheme});'),'the card lists the schemes of the effective mode with the swatch of the active one');
assert.ok(preferences.includes('choice=shownSchemeChoice(useSchemeChoice(),brandScheme)')&&preferences.includes('t(schemeLabel(scheme,brandScheme))'),'the card shows brand as Aurora without a brand scheme and labels the default');
const schemeSource=read('ui/shell/color-scheme.tsx');
assert.doesNotMatch(schemeSource,/DropdownMenu|ColorSchemeMenu|ColorSchemeItems|ColorSchemeTrigger/,'no radix submenu is left');
assert.ok(!/ColorScheme/.test(read('ui/shell/shell.tsx')),'the account menu has no color scheme submenu');
checks+=6;

// The setter shows the scheme at once and writes the cookie; a blocked cookie is ignored. The menu stays open.
const fake=(protocol,cookieFails=false,dataset={})=>{const target={document:{documentElement:{dataset},written:[]},location:{protocol}};Object.defineProperty(target.document,'cookie',{set(value){if(cookieFails)throw new Error('blocked');target.document.written.push(value);},get(){return '';}});return target;};
let target=fake('https:');
scheme.applySchemeChoice({light:'ember',dark:'prompt-blue'},target);
assert.deepEqual({...target.document.documentElement.dataset},{schemeLight:'ember',schemeDark:'prompt-blue'});
assert.deepEqual(target.document.written,['serverdesk-scheme=ember.prompt-blue; Path=/; Max-Age=31536000; SameSite=Lax; Secure']);
assert.deepEqual(scheme.currentSchemeChoice(target),{light:'ember',dark:'prompt-blue'});
target=fake('http:',false,{schemeLight:'ember',schemeDark:'aurora'});
scheme.selectScheme('prompt-blue','dark',target);
assert.deepEqual({...target.document.documentElement.dataset},{schemeLight:'ember',schemeDark:'prompt-blue'});
scheme.selectScheme('cyber-teal','light',target);
assert.deepEqual({...target.document.documentElement.dataset},{schemeLight:'cyber-teal',schemeDark:'cyber-teal'});
assert.deepEqual(target.document.written,['serverdesk-scheme=ember.prompt-blue; Path=/; Max-Age=31536000; SameSite=Lax','serverdesk-scheme=cyber-teal.cyber-teal; Path=/; Max-Age=31536000; SameSite=Lax']);
target=fake('https:',true);
assert.doesNotThrow(()=>scheme.selectScheme('inkberry','dark',target));
assert.deepEqual({...target.document.documentElement.dataset},{schemeLight:'inkberry',schemeDark:'inkberry'},'a blocked cookie only loses persistence');
assert.deepEqual(scheme.currentSchemeChoice({document:{documentElement:{dataset:{}}}}),both('brand'));
assert.deepEqual(scheme.currentSchemeChoice({document:{documentElement:{dataset:{schemeLight:'prompt-blue',schemeDark:'ember'}}}}),both('brand'));
assert.match(read('ui/account/account-preferences.tsx'),/if\(scheme\)setScheme\(scheme\.id,mode\)/,'the Select applies a known scheme of the mode at once');
assert.doesNotMatch(schemeSource,/toast|location\.reload/,'no toast and no reload');
checks+=8;

// The effective mode is the theme, or for "system" the OS setting, and follows an OS change.
const media=dark=>({matchMedia:query=>{assert.equal(query,'(prefers-color-scheme: dark)');return {matches:dark};}});
assert.equal(scheme.effectiveMode('light',media(true)),'light');
assert.equal(scheme.effectiveMode('dark',media(false)),'dark');
assert.equal(scheme.effectiveMode('system',media(true)),'dark');
assert.equal(scheme.effectiveMode('system',media(false)),'light');
assert.equal(scheme.effectiveMode('system',{}),'light','without matchMedia: light');
const added=[],removed=[];
globalThis.matchMedia=query=>({matches:false,media:query,addEventListener:(type,listener)=>added.push([query,type,listener]),removeEventListener:(type,listener)=>removed.push([query,type,listener])});
const listener=()=>{};
const stop=scheme.subscribeSystemMode(listener);
assert.deepEqual(added,[['(prefers-color-scheme: dark)','change',listener]],'subscribes to the OS mode');
stop();
assert.deepEqual(removed,[['(prefers-color-scheme: dark)','change',listener]],'and unsubscribes');
delete globalThis.matchMedia;
assert.match(schemeSource,/useSyncExternalStore\(subscribeSystemMode,/,'the menu follows the OS mode');
checks+=7;

// Palette actions per scheme of the current mode, same effect, no new shortcut.
for(const [mode,value] of [['light','de'],['dark','en'],['dark','de']]){
 const picked=[];
 const items=scheme.schemePaletteItems(mode,value,(id,pickedMode)=>picked.push([id,pickedMode]));
 assert.deepEqual(items.map(item=>[item.group,item.label,item.keywords]),schemesFor(mode,{brand:false}).map(item=>[value==='en'?'Actions':'Aktionen',`${value==='en'?'Color scheme':'Farbschema'}: ${translate(value,item.name)}`,'farbschema farbe schema color scheme akzent']));
 assert.equal(new Set(items.map(item=>item.id)).size,items.length);
 for(const item of items)item.run();
 assert.deepEqual(picked,schemesFor(mode,{brand:false}).map(item=>[item.id,mode]));
}
assert.equal(scheme.schemePaletteItems('light','de')[4].label,'Farbschema: Ember & Porcelain');
// Palette items with and without a brand scheme.
assert.deepEqual(scheme.schemePaletteItems('light','en').map(item=>item.id).includes('action-scheme-brand'),false,'no brand item without a brand scheme');
assert.deepEqual(scheme.schemePaletteItems('light','en',()=>{},true).slice(0,2).map(item=>[item.id,item.label]),[['action-scheme-brand','Color scheme: Brand colors (default)'],['action-scheme-aurora','Color scheme: Aurora']],'with one: Brand colors (default) first, then Aurora');
assert.match(read('ui/shell/console.tsx'),/\.\.\.schemePaletteItems\(effectiveMode\(currentTheme\(\)\),locale,undefined,data\?\.branding\?\.scheme!=null\)/,'the console palette lists the scheme actions of the current mode and passes whether a brand scheme exists');

assert.doesNotMatch(read('ui/shell/console-shortcuts.ts'),/scheme|farbschema/i,'no new shortcut');
checks+=4;

// The preferences tip names the color scheme and the card that holds it.
assert.equal(topicFor({view:'account'},'de').tips[2],'Darstellung, Farbschema, Sprache und Startseite legst du auf dieser Seite unter „Einstellungen der Oberfläche“ fest.');
assert.equal(topicFor({view:'account'},'en').tips[2],'You set the appearance, color scheme, language and start page under “Preferences” on this page.');
checks+=2;

// The scheme list, the cookie format and every adjusted value are pinned by
// this file and by tests/ui/styles/theme-tokens.mjs.

console.log(`PASS color schemes (${checks} check groups): list, cookie per mode, layout attributes, submenu, setter, effective mode, palette and help.`);
