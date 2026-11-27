// English UI: locale cookie and <html lang>, the message
// catalogs, translate() and the format helpers, the language switch in the
// account menu and the palette, and the translated console frame.
import {mock} from '../support/register.mjs';
// Loaded before the hooks of register.mjs, so this is the real package. The mock
// below hands it on unchanged, except that dialogs render in place: React's
// static renderer leaves portals empty, and Drawer, Sheet and the palette use one.
import * as radix from 'radix-ui';
import assert from 'node:assert/strict';
import {existsSync,readFileSync,readdirSync,statSync} from 'node:fs';
import path from 'node:path';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {germanIn,visible} from '../support/german-text.mjs';
import {translatedFiles} from '../support/translated-files.mjs';

process.env.TZ='UTC';
let cookieJar={};
let acceptLanguage=null;
mock('next/headers',{cookies:async()=>({get:name=>cookieJar[name]!==undefined?{name,value:cookieJar[name]}:undefined}),headers:async()=>new Headers(acceptLanguage===null?{}:{'accept-language':acceptLanguage})});
mock('radix-ui',{...radix,Dialog:{...radix.Dialog,Portal:({children})=>children},DropdownMenu:{...radix.DropdownMenu,Portal:({children})=>children}});

const {locales,defaultLocale,localeCookieName,parseLocale,localeCookie,negotiateLocale,documentLocale}=await import('../../lib/i18n/locale.ts');
const {default:en}=await import('../../lib/i18n/messages/en.ts');
const {default:de}=await import('../../lib/i18n/messages/de.ts');
const {translate}=await import('../../lib/i18n/translate.ts');
const {formatClock,formatDate,formatDateTime,formatNumber,formatRelative,formatPercent,formatTime,formatBytes,formatRate,formatDuration,formatTemperature,EMPTY_VALUE}=await import('../../lib/i18n/format.ts');
const {default:RootLayout,generateMetadata}=await import('../../app/layout.tsx');
const locale=await import('../../ui/base/locale.tsx');
const theme=await import('../../ui/shell/theme.tsx');
const shell=await import('../../ui/shell/shell.tsx');
const kit=await import('../../ui/kit/kit.tsx');
const {topicFor,default:HelpPanel}=await import('../../ui/shell/help-panel.tsx');
const {default:CommandPalette}=await import('../../ui/shell/command-palette.tsx');
const {shortcutList,shortcutOr}=await import('../../ui/shell/console-shortcuts.ts');
const h=React.createElement;
const read=file=>readFileSync(file,'utf8');
const render=node=>renderToStaticMarkup(node);
const inLocale=(value,node)=>h(locale.LocaleProvider,{locale:value},node);
let checks=0;

// Values, parsing and the cookie string.
assert.deepEqual([...locales],['en','de']);
assert.equal(defaultLocale,'en','English is the default');
assert.equal(localeCookieName,'serverdesk-locale');
for(const value of locales)assert.equal(parseLocale(value),value);
for(const value of [undefined,null,'','EN','De','fr','en; x',' de','de ',1,{},['en'],'garbage'])assert.equal(parseLocale(value),'en',`parseLocale(${JSON.stringify(value)})`);
assert.equal(documentLocale(),'en','outside a browser the page language is the default');
assert.equal(localeCookie('en',false),'serverdesk-locale=en; Path=/; Max-Age=31536000; SameSite=Lax');
assert.equal(localeCookie('de',true),'serverdesk-locale=de; Path=/; Max-Age=31536000; SameSite=Lax; Secure');
for(const value of locales)for(const secure of [false,true])assert.doesNotMatch(localeCookie(value,secure),/httponly/i);
assert.equal((read('lib/i18n/locale.ts').match(/defaultLocale\s*(?::\s*Locale\s*)?=/g)??[]).length,1,'defaultLocale is decided in one place');
// negotiateLocale: a valid cookie wins, then the highest q of a supported primary subtag, then the default.
for(const [cookie,header,expected] of [
 ['de','en-US,en;q=0.9','de'],['en','de-DE,de;q=0.9','en'],[undefined,'de-CH','de'],[undefined,'EN-us','en'],[undefined,'en-US,de;q=0.9','en'],
 [undefined,'de;q=0,en;q=0.1','en'],[undefined,'*','en'],[undefined,'fr','en'],[undefined,'','en'],[undefined,null,'en'],[undefined,undefined,'en'],
 [undefined,';;;,q=,de;q=abc',  'en'],[undefined,'fr;q=1,de;q=0.5,en;q=0.5','de'],[undefined,'de;q=0.3,en;q=0.8','en'],['fr','de','de'],['EN','de','de'],
 [undefined,Array.from({length:1000},()=>'fr').join(',')+',de','en'],[undefined,Array.from({length:19},()=>'fr').join(',')+',de','de'],[undefined,'x'.repeat(100000),'en'],
])assert.equal(negotiateLocale(cookie,header),expected,`negotiateLocale(${JSON.stringify(cookie)}, ${JSON.stringify(String(header).slice(0,40))})`);
checks+=7;

// The root layout renders lang from the cookie, keeps data-theme and adds no script.
function Probe(){const t=locale.useT();return h('main',null,t('shell.signOut'));}
const layout=async(cookies,header=null)=>{cookieJar=cookies;acceptLanguage=header;return render(await RootLayout({children:h(Probe)}));};
const metadataFor=async(cookies,header=null)=>{cookieJar=cookies;acceptLanguage=header;return generateMetadata();};
for(const [cookies,lang,themeValue,text,header] of [
 [{'serverdesk-locale':'en'},'en','system','Sign out'],
 [{'serverdesk-locale':'de','serverdesk-theme':'dark'},'de','dark','Abmelden'],
 [{},'en','system','Sign out'],
 [{'serverdesk-locale':'fr','serverdesk-theme':'system'},'en','system','Sign out'],
 [{'serverdesk-locale':'EN'},'en','system','Sign out'],
 [{'serverdesk-locale':'en','serverdesk-theme':'dark'},'en','dark','Sign out'],
 // Without a cookie Accept-Language decides; a cookie always wins.
 [{},'de','system','Abmelden','de-DE,de;q=0.9'],
 [{'serverdesk-locale':'en'},'en','system','Sign out','de-DE,de;q=0.9'],
 [{'serverdesk-locale':'de'},'de','system','Abmelden','en-US'],
 [{},'en','system','Sign out','fr-FR,fr;q=0.9'],
]){
 const html=await layout(cookies,header);
 assert.match(html,new RegExp(`^<html lang="${lang}" data-theme="${themeValue}" data-density="comfortable"(?: data-scheme-(?:light|dark)="[a-z-]+")*>`),JSON.stringify(cookies));
 assert.ok(html.includes(`<main>${text}</main>`),`the provider gets the parsed locale for ${JSON.stringify(cookies)}`);
 assert.ok(!html.includes('<script'),'no inline script');
}
for(const [cookies,header,description] of [[{},null,'Monitor, diagnose'],[{},'de-DE,de;q=0.9','Windows Server 2022 / 2025 und Windows 11'],[{'serverdesk-locale':'en'},'de','Monitor, diagnose']])assert.ok(String((await metadataFor(cookies,header)).description).startsWith(description),`metadata for ${JSON.stringify(cookies)} ${header}`);
assert.doesNotMatch(read('app/layout.tsx'),/cookies().set|Set-Cookie/i,'the server writes no cookie');
checks+=5;

// sign-out keeps the cookie. Only the locale modules name the cookie, write it or set <html lang>.
const walk=dir=>!existsSync(dir)?[]:readdirSync(dir).flatMap(name=>{const file=path.posix.join(dir,name);return statSync(file).isDirectory()?walk(file):/\.(ts|tsx)$/.test(file)?[file]:[];});
const sources=[...walk('app'),...walk('lib'),...walk('ui'),'proxy.ts'];
const localeModules=['lib/i18n/locale.ts','ui/base/locale.tsx'];
for(const file of sources){
 const text=read(file);
 assert.doesNotMatch(text,/Clear-Site-Data/i,`${file} does not clear site data`);
 if(!localeModules.includes(file))assert.doesNotMatch(text,/serverdesk-locale|localeCookie\(|documentElement\.lang\s*=|setAttribute\(\s*['"]lang/,`${file} does not write the language`);
}
assert.match(read('ui/session/session-gate.tsx'),/export (async )?function signOutPortal/,'the sign-out code is part of the scan');
checks+=2;

// Same keys, valid values, same placeholders per key, plurals use {count}.
// Plurals whose count selects the form but whose text names the counted items instead of the number:
// entra.check.keptOwners lists the account names ({accounts}), so "{count}" would only repeat them.
// The detail of a Dashboard widget stands right after its lead number ("3" then "devices need attention"): the count
// selects the form, and "{count}" would show the number twice.
const pluralsWithoutCount=new Set(['entra.check.keptOwners','dashboard.attention','dashboard.pinned.detail','dashboard.customers.detail','dashboard.diskSpace.detail','dashboard.restart.detail','dashboard.osSupport.detail','dashboard.agents.detail','dashboard.encryption.detail','dashboard.autostart.detail','dashboard.diskHealth.detail','dashboard.activity.detail']);
const placeholders=value=>[...new Set((typeof value==='string'?value:`${value.one} ${value.other}`).match(/\{\w+\}/g)??[])].sort();
assert.deepEqual(Object.keys(de).sort(),Object.keys(en).sort(),'en and de have the same keys');
for(const key of Object.keys(en)){
 // audit.action.<code> keeps the stored code as written (ui/devices/history/audit-display.ts), dashes included.
 assert.match(key,/^(?:audit\.action\.[\w.-]+|(?:activity|shell|rail|nav|palette|help|shortcuts|dashboard|kit|kpi|language|theme|scheme|inheritance|alertRules|alarms|tags|common|identity|session|mfa|password|passkeys|account|accounts|meta|console|fleet|csv|tree|groups|jobs|maintenance|maintenancePage|previousSecret|device|hardware|monitoring|monitoringTab|services|network|updates|management|storage|files|rdp|diagnostics|terminal|history|system|access|rbac|customers|usageData|sessionSettings|settings|audit|roles|catalog|crossCustomer|automation|runbooks|drift|desired|releases|releaseSource|agents|agentMode|addDevice|agentUpdates|agentMessage|agentReason|troubleshooting|usage|operation|crashes|osSupport|software|encryption|bitlocker|drivers|deviceProblem|reliability|diskHealth|battery|certificates|autostart|accessPanel|apiError|serverMessage|notifications|notificationRules|notifyMessage|vulnerabilities|health|problems|startPage|serverRoles|extensions|defender|protection|assistant|assistantSettings|pluginAd|dhcp|dns|permission|agentIntegrity|entra|alarm|notification|branding|deviceType|pins|density|devices|windowsLicense)\.[\w.]+)$/,`${key} is grouped by area`);
 for(const [name,catalog] of [['en',en],['de',de]]){
  const value=catalog[key];
  if(typeof value==='string')assert.ok(value.trim().length>0,`${name} ${key} is not empty`);
  else{assert.deepEqual(Object.keys(value).sort(),['one','other'],`${name} ${key} is a plural`);assert.ok(value.one.trim()&&value.other.trim(),`${name} ${key} forms are not empty`);if(!pluralsWithoutCount.has(key))assert.match(value.other,/\{count\}/,`${name} ${key} other uses {count}`);}
 }
 assert.equal(typeof en[key],typeof de[key],`${key} is a plural in both or in neither`);
 assert.deepEqual(placeholders(de[key]),placeholders(en[key]),`${key} has the same placeholders`);
}
checks+=4;
// The maintenance run reasons (runtime/maintenance.mjs, maintenanceFailures) and the two drawer descriptions of Data retention.
for(const key of ['maintenancePage.retentionDrawerDescription','maintenancePage.scheduleDrawerDescription',...['retentionInvalid','lockLost','lockExpired','transfersFailed','internal'].map(reason=>`serverMessage.maintenance.${reason}`)]){
 assert.ok(typeof en[key]==='string'&&typeof de[key]==='string'&&en[key]!==de[key],`${key} exists in both catalogs and is translated`);
}
checks++;

// Placeholders, plurals for 0, 1 and 2, unknown keys.
assert.equal(translate('en','shell.accountLabel',{name:'Anna'}),'Account: Anna');
assert.equal(translate('de','shell.accountLabel',{name:'Anna'}),'Konto: Anna');
assert.equal(translate('en','shell.freshness.updated',{time:'14:05'}),'Updated 14:05');
assert.equal(translate('de','palette.noResults',{query:'srv'}),'Keine Treffer für „srv“. Suche nach Gerätename, IP-Adresse, Gruppe oder Seite.');
assert.equal(translate('en','shell.accountLabel'),'Account: {name}','a missing parameter keeps its placeholder');
assert.deepEqual([0,1,2].map(count=>translate('en','kit.daysAgo',{count})),['0 days ago','1 day ago','2 days ago']);
assert.deepEqual([0,1,2].map(count=>translate('de','kit.daysAgo',{count})),['vor 0 Tagen','vor 1 Tag','vor 2 Tagen']);
for(const value of locales){
 assert.equal(translate(value,'no.such.key'),'no.such.key','unknown key returns the key');
 assert.equal(translate(value,'no.such.key',{count:2}),'no.such.key');
 assert.equal(translate(value,'toString'),'toString','prototype names are not keys');
}
assert.equal(translate('xx','shell.signOut'),'Sign out','an unknown locale falls back to the default');
checks+=12;

// Format helpers, and the kit helpers unchanged in German.
assert.equal(formatPercent('de',42.4),'42 %');assert.equal(formatPercent('en',42.4),'42%');
assert.equal(formatPercent('de',null),'—');assert.equal(formatPercent('en',null),'—');
assert.equal(formatPercent('de',99.5),'100 %');
// Byte counts and rates in IEC units: the largest unit with a value of at least 1 (TiB at most), one
// fraction digit below 10, none from 10 up, never for B, a no-break space before the unit.
assert.equal(EMPTY_VALUE,'—');assert.equal(formatPercent('en',null),EMPTY_VALUE);
const nbsp='\u00a0';
for(const [locale,bytes,options,expected] of [
 ['en',0,undefined,`0${nbsp}B`],['de',0,undefined,`0${nbsp}B`],['en',1023,undefined,`1,023${nbsp}B`],
 ['en',1536,undefined,`1.5${nbsp}KiB`],['de',1536,undefined,`1,5${nbsp}KiB`],['en',9.96*1024,undefined,`10${nbsp}KiB`],
 ['en',68*2**30,undefined,`68${nbsp}GiB`],['de',19.8*2**30,undefined,`20${nbsp}GiB`],
 ['en',2**30,{unit:'MiB'},`1,024${nbsp}MiB`],['de',2**30,{unit:'MiB'},`1.024${nbsp}MiB`],['en',512,{unit:'KiB'},`0.5${nbsp}KiB`],
 ['de',3*2**40*1024,undefined,`3.072${nbsp}TiB`],['en',5*2**40,undefined,`5${nbsp}TiB`],
])assert.equal(formatBytes(locale,bytes,options),expected,`formatBytes(${locale}, ${bytes})`);
for(const bad of [null,undefined,Number.NaN,Infinity,-Infinity,-1])for(const locale of ['en','de']){assert.equal(formatBytes(locale,bad),EMPTY_VALUE,`formatBytes(${bad})`);assert.equal(formatRate(locale,bad),EMPTY_VALUE,`formatRate(${bad})`);}
assert.equal(formatRate('en',1258291),`1.2${nbsp}MiB/s`);assert.equal(formatRate('de',12*1024),`12${nbsp}KiB/s`);assert.equal(formatRate('en',0),`0${nbsp}B/s`);assert.equal(formatRate('de',1258291),`1,2${nbsp}MiB/s`);
// Durations (UI-Rework 15, C18): ms below one second, s with one fraction digit below 10, min, h with min; the unit
// words from the catalog (kit.unit.*), a no-break space between number and unit.
for(const [ms,english,german] of [
 [0,`0${nbsp}ms`,`0${nbsp}ms`],[850,`850${nbsp}ms`,`850${nbsp}ms`],[999.6,`1${nbsp}s`,`1${nbsp}s`],[1500,`1.5${nbsp}s`,`1,5${nbsp}s`],[9960,`10${nbsp}s`,`10${nbsp}s`],[12000,`12${nbsp}s`,`12${nbsp}s`],
 [4*60000,`4${nbsp}min`,`4${nbsp}Min`],[59*60000,`59${nbsp}min`,`59${nbsp}Min`],[3600000,`1${nbsp}h`,`1${nbsp}Std`],[2*3600000+5*60000,`2${nbsp}h${nbsp}5${nbsp}min`,`2${nbsp}Std${nbsp}5${nbsp}Min`],
])assert.deepEqual([formatDuration('en',ms),formatDuration('de',ms)],[english,german],`formatDuration(${ms})`);
for(const bad of [null,undefined,Number.NaN,Infinity,-1])for(const locale of ['en','de'])assert.equal(formatDuration(locale,bad),EMPTY_VALUE,`formatDuration(${bad})`);
// Temperatures: rounded, a no-break space before °C.
assert.deepEqual([formatTemperature('en',41.4),formatTemperature('de',66.6),formatTemperature('en',-3)],[`41${nbsp}°C`,`67${nbsp}°C`,`-3${nbsp}°C`]);
for(const bad of [null,undefined,Number.NaN])assert.equal(formatTemperature('de',bad),EMPTY_VALUE,`formatTemperature(${bad})`);
const now=Date.UTC(2026,9,23,14,5),second=1000,minute=60*second,hour=60*minute,day=24*hour;
const relative=[[null,'Never','Noch nie'],[now-10*second,'Just now','Gerade eben'],[now-44*second,'Just now','Gerade eben'],[now-45*second,'1 min ago','vor 1 Min'],[now-59*minute,'59 min ago','vor 59 Min'],[now-hour,'1 h ago','vor 1 Std'],[now-23*hour,'23 h ago','vor 23 Std'],[now-day,'Yesterday','Gestern'],[now-2*day,'2 days ago','vor 2 Tagen'],[now+minute,'Just now','Gerade eben']];
for(const [value,english,german] of relative){
 assert.equal(formatRelative('en',value,now),english,`en ${value}`);
 assert.equal(formatRelative('de',value,now),german,`de ${value}`);
 assert.equal(kit.relativeTime(value,now),english,'relativeTime is English by default');
 assert.equal(kit.relativeTime(value,now,'de'),german);
 assert.equal(kit.relativeTime(value,now,'en'),english);
}
assert.equal(formatClock('de',now),'14:05');
assert.match(formatClock('en',now),/^02:05\sPM$/u);
assert.equal(formatDateTime('de',now),'23.10.2026, 14:05:00');
assert.match(formatDateTime('en',now),/^10\/23\/2026, 2:05:00\sPM$/u);
assert.equal(formatDateTime('de',null),'Keine Angabe');assert.equal(formatDateTime('en',undefined),'Not available');
assert.equal(kit.exactTime(now,'de'),'23.10.2026, 14:05:00');assert.equal(kit.exactTime(null,'de'),'Keine Angabe');assert.equal(kit.exactTime(new Date(now).toISOString(),'de'),'23.10.2026, 14:05:00');assert.equal(kit.exactTime(now),formatDateTime('en',now),'exactTime is English by default');
// formatNumber, formatDate and formatTime pass Intl options through; German equals the old 'de-DE' calls.
assert.equal(formatNumber('de',1.5,{maximumFractionDigits:1}),'1,5');assert.equal(formatNumber('en',1.5,{maximumFractionDigits:1}),'1.5');
assert.equal(formatNumber('de',65536),(65536).toLocaleString('de-DE'));assert.equal(formatNumber('en',65536),'65,536');
const dayOptions={day:'2-digit',month:'2-digit',year:'numeric'},clockOptions={hour:'2-digit',minute:'2-digit',second:'2-digit'};
assert.equal(formatDate('de',now,dayOptions),new Date(now).toLocaleDateString('de-DE',dayOptions));assert.equal(formatDate('de',now,dayOptions),'23.10.2026');
assert.equal(formatTime('de',now,clockOptions),new Date(now).toLocaleTimeString('de-DE',clockOptions));assert.equal(formatTime('de',now),new Date(now).toLocaleTimeString('de-DE'));
assert.equal(formatDateTime('de',now,{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}),new Date(now).toLocaleString('de-DE',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}));
assert.match(formatDate('en',now,dayOptions),/^10\/23\/2026$/);
checks+=4;
assert.equal(kit.percentLabel(42.4,'de'),'42 %');assert.equal(kit.percentLabel(42.4),'42%','English by default');assert.equal(kit.percentLabel(null),'—');assert.equal(kit.percentLabel(42.4,'en'),'42%');
assert.match(read('ui/shell/console.tsx'),/t\('shell\.freshness\.updated',\{time:formatClock\(locale,checkedAt\)\}\)/,'the freshness status uses formatClock');
checks+=20;

// The setter shows the language at once, writes the cookie and notifies; a blocked cookie is ignored.
const fake=(protocol,cookieFails=false)=>{const target={document:{documentElement:{lang:'de'},written:[]},location:{protocol}};Object.defineProperty(target.document,'cookie',{set(value){if(cookieFails)throw new Error('blocked');target.document.written.push(value);},get(){return '';}});return target;};
const heard=[];const stop=locale.subscribeLocale(value=>heard.push(value));
let target=fake('https:');
locale.applyLocale('en',target);
assert.equal(target.document.documentElement.lang,'en');
assert.deepEqual(target.document.written,['serverdesk-locale=en; Path=/; Max-Age=31536000; SameSite=Lax; Secure']);
target=fake('http:');
locale.applyLocale('de',target);
assert.deepEqual(target.document.written,['serverdesk-locale=de; Path=/; Max-Age=31536000; SameSite=Lax']);
target=fake('https:',true);
assert.doesNotThrow(()=>locale.applyLocale('en',target));
assert.equal(target.document.documentElement.lang,'en','a blocked cookie still applies the language');
assert.deepEqual(heard,['en','de','en'],'subscribers hear every change');
stop();locale.applyLocale('de',fake('http:'));
assert.equal(heard.length,3,'unsubscribed listeners stay quiet');
assert.equal(render(h(Probe)),'<main>Sign out</main>','useT without a provider uses English');
function LocaleProbe(){const [value]=locale.useLocale();return h('i',null,value);}
assert.equal(render(h(LocaleProbe)),'<i>en</i>');assert.equal(render(inLocale('de',h(LocaleProbe))),'<i>de</i>');
assert.equal(render(inLocale('en',h(LocaleProbe))),'<i>en</i>');
const localeSource=read('ui/base/locale.tsx');
assert.match(localeSource,/subscribeLocale\(setLocale\)/,'the provider follows applyLocale, so all text changes without a reload');
assert.doesNotMatch(localeSource,/toast|location\.reload/,'no toast and no reload');
checks+=11;

// The language group in the account menu (a kit MenuRadioEntry).
for(const value of locales){
 const menu=render(inLocale(value,h(kit.Menu,{label:'Account',open:true,entries:[locale.languageMenuEntry(value,()=>{},(key,params)=>translate(value,key,params))]})));
 assert.ok(menu.includes(`>${value==='en'?'Language':'Sprache'}<`),`${value}: heading`);
 const radios=[...menu.matchAll(/<div[^>]*role="menuitemradio"[^>]*>.*?<span>([^<]+)<\/span>/g)];
 assert.deepEqual(radios.map(match=>match[1]),['English','Deutsch'],`${value}: entries in their own language`);
 assert.deepEqual(radios.map(([html])=>html.match(/\blang="(\w+)"/)?.[1]),['en','de'],`${value}: each entry has its own lang`);
 assert.deepEqual(radios.map(([html])=>html.match(/aria-checked="(\w+)"/)[1]),value==='en'?['true','false']:['false','true'],`${value}: the active entry is checked`);
 for(const [html] of radios)assert.match(html,/class="sdx-menu-item"/);
 assert.equal((menu.match(/lucide-check/g)??[]).length,1,`${value}: only the active entry shows the check`);
}
assert.match(localeSource,/export function languageMenuEntry\(/,'the language group is a builder of kit menu entries');
const viewer={label:'anna@example.test',username:'anna',displayName:'Anna',permissions:['*']};
const noop=()=>{};
const accountMenu=value=>render(inLocale(value,h(shell.AccountMenu,{viewer,saving:false,onAccount:noop,onSignOut:noop,open:true})));
// The short menu: head, My account, appearance, language, sign out. Color scheme and start page are in My account.
for(const [value,words] of [['en',['sdx-account-head','My account','Appearance','Language','Sign out']],['de',['sdx-account-head','Mein Konto','Darstellung','Sprache','Abmelden']]]){
 const menu=accountMenu(value);let at=-1;
 for(const word of words){const next=menu.indexOf(word,at+1);assert.ok(next>at,`${value} account menu: ${word} follows`);const separator=menu.indexOf('sdx-menu-separator',at+1);if(word!=='sdx-account-head')assert.ok(separator>at&&separator<next,`${value}: a separator before ${word}`);at=next;}
 assert.equal((menu.match(/class="sdx-menu-separator"/g)??[]).length,4,'four separators');
 assert.ok(!/Color scheme|Start page|Farbschema|Startseite/.test(menu),`${value}: no color scheme and no start page`);
}
checks+=7;

// Palette actions in the actions group, no new shortcut.
for(const value of locales){
 const picked=[];
 const items=locale.languagePaletteItems(value,next=>picked.push(next));
 assert.deepEqual(items.map(item=>[item.group,item.label,item.keywords]),value==='en'
  ?[['Actions','Switch language to English','language sprache english englisch deutsch german locale'],['Actions','Switch language to German','language sprache english englisch deutsch german locale']]
  :[['Aktionen','Sprache auf Englisch umstellen','language sprache english englisch deutsch german locale'],['Aktionen','Sprache auf Deutsch umstellen','language sprache english englisch deutsch german locale']]);
 for(const item of items)item.run();
 assert.deepEqual(picked,['en','de']);
 assert.equal(new Set(items.map(item=>item.id)).size,2);
}
assert.equal(locale.languagePaletteItems()[0].label,'Switch language to English','English by default');
assert.equal(locale.languagePaletteItems('de')[0].label,'Sprache auf Englisch umstellen');
assert.match(read('ui/shell/console.tsx'),/\.\.\.languagePaletteItems\(locale,setLocale\)/,'the console palette lists the language actions');
assert.doesNotMatch(read('ui/shell/console-shortcuts.ts'),/language|sprache|locale/i,'no new shortcut');
checks+=5;

// The language tip in "Mein Konto".
assert.equal(topicFor({view:'account'},'en').tips.at(-1),'Appearance and language are also in your account menu at the top right.');
assert.deepEqual(topicFor({view:'settings',page:'agent-releases'},'en').tips,['New agent releases come from GitHub. They appear in the catalog after the daily cleanup or after you select “Check now” at the top of the page.','An imported release reaches devices only when you start an update with “Agent updates” in “All devices”. To deactivate or delete a release, open its row menu.'],'Agents → Releases has its own help topic');
assert.equal(topicFor({view:'add-device'},'en').title,'Add device');
// The three Extensions views: F1 opens their own topic with two tips and the doc link Extensions.
for(const [route,title,german] of [[{view:'devices',tab:'extensions'},'Extensions','Erweiterungen'],[{view:'device',deviceId:'d1',deviceSection:'extensions'},'Extensions','Erweiterungen'],[{view:'settings',page:'extensions'},'Extension releases','Releases der Erweiterungen']]){
 const english=topicFor(route,'en'),de=topicFor(route,'de');
 assert.deepEqual([english.title,de.title,english.tips.length,english.docs.map(doc=>[doc.label,doc.file])],[title,german,2,[['Extensions','docs/extensions.md']]],JSON.stringify(route));
 assert.ok(english.tips.every(tip=>!/plugin/i.test(tip))&&de.tips.every(tip=>!/plugin/i.test(tip)),'no tip names a plugin');
}
for(const section of ['dhcp','dns'])assert.deepEqual(topicFor({view:'device',deviceId:'d1',deviceSection:'extensions',deviceDetail:section},'en').docs.map(doc=>doc.file),[`docs/${section}-server.md`,'docs/extensions.md'],`${section}: the doc link Extensions`);
checks+=2;
assert.equal(topicFor({view:'account'},'de').tips.at(-1),'Darstellung und Sprache findest du auch im Kontomenü oben rechts.');
assert.equal(topicFor({view:'account'}).tips.at(-1),'Appearance and language are also in your account menu at the top right.','English by default');
assert.equal(topicFor({view:'account'},'de').tips.length,4);
checks+=3;

// The frame in English has no German, in German it is unchanged.
const topbarProps=value=>({viewer,saving:false,navigatorOpen:true,canToggleNavigator:true,onToggleNavigator:noop,onSearch:noop,onRefresh:noop,loading:false,status:translate(value,'shell.freshness.updated',{time:formatClock(value,now)}),onHelp:noop,onAccount:noop,onSignOut:noop});
const railItems=value=>[['devices','G D'],['automation','G A'],['settings','G S']].map(([id,shortcut])=>({id,label:translate(value,'rail.'+id),icon:()=>null,shortcut,onSelect:noop,...(id==='settings'?{placement:'end'}:{})}));
const frame=value=>[
 render(inLocale(value,h(shell.Topbar,topbarProps(value)))),
 render(inLocale(value,h(shell.Topbar,{...topbarProps(value),navigatorOpen:false}))),
 accountMenu(value),
 render(inLocale(value,h(shell.Rail,{items:railItems(value),area:'devices'}))),
 render(inLocale(value,h(shell.Breadcrumbs,{items:[{label:translate(value,'nav.allDevices'),href:'#devices',onSelect:noop},{label:'Berlin'}]}))),
 render(inLocale(value,h(kit.Drawer,{open:true,onClose:noop,title:'Job'},h('p',null,'Body')))),
 render(inLocale(value,h(kit.IconBtn,{icon:()=>null,label:translate(value,'shell.search'),shortcut:'Control+K'}))),
 render(inLocale(value,h(HelpPanel,{open:true,onOpenChange:noop,route:{view:'devices'}}))),
 render(inLocale(value,h(CommandPalette,{open:true,onOpenChange:noop,getItems:()=>[...theme.themePaletteItems(noop,value),...locale.languagePaletteItems(value,noop)]}))),
].join('\n');
const english=frame('en'),german=frame('de');
assert.deepEqual(germanIn(visible(english)),[],'no German text in the English frame');
assert.ok(germanIn(visible(german)).length>=10,'the guard recognizes the German frame');
for(const text of ['Hide navigator','Show navigator','aria-label="Nodiverna device overview"','Search devices, groups, pages and actions','aria-label="Search (Ctrl+K)"','>Ctrl K<','aria-label="Refresh data" aria-keyshortcuts="R"','aria-label="Help"','aria-label="Account: Anna"','No role','My account','Sign out','Updated 02:05','Appearance','>Light<','>Dark<','>Match system<','Language','aria-label="Areas"','>Devices<','>Settings<','aria-label="Path"','All devices','aria-label="Close"','title="Close (Esc)"','(Ctrl+K)','>Help<','On this page','Keyboard shortcuts','Documentation','All devices','Use “Filters” above the table to show only devices with a certain state, health level or support status.','Device tree, groups and permissions','Focus the device search in the overview','>or<','>Device<','Close dialog or panel','Search and jump','placeholder="Search devices, groups, pages or actions"','aria-label="Search term"','> select<','> open<','> Help and keyboard shortcuts<','>Actions<','Light appearance','Appearance: match system','Switch language to English'])assert.ok(english.includes(text),`English frame shows ${text}`);
for(const text of ['Navigator ausblenden','Navigator einblenden','aria-label="Nodiverna Geräteübersicht"','Geräte, Gruppen, Seiten und Aktionen suchen','aria-label="Suchen (Strg+K)"','>Strg K<','aria-label="Daten aktualisieren" aria-keyshortcuts="R"','aria-label="Hilfe"','aria-label="Konto: Anna"','Keine Rolle','Mein Konto','Abmelden','Aktualisiert 14:05','Darstellung','>Hell<','>Dunkel<','>Wie System<','Sprache','aria-label="Bereiche"','>Geräte<','>Einstellungen<','aria-label="Pfad"','Alle Geräte','aria-label="Schließen"','title="Schließen (Esc)"','(Strg+K)','>Hilfe<','Auf dieser Seite','Tastenkürzel','Dokumentation','Geräteübersicht','Mit „Filter“ über der Tabelle zeigst du nur Geräte mit einem bestimmten Zustand, einer Health-Stufe oder einem Supportstatus.','Geräteinventar','Gerätesuche in der Übersicht fokussieren','>oder<','>Gerät<','Dialog oder Panel schließen','Suchen und springen','placeholder="Geräte, Gruppen, Seiten oder Aktionen suchen"','aria-label="Suchbegriff"','> auswählen<','> öffnen<','> Hilfe und Tastenkürzel<','>Aktionen<','Helle Darstellung','Darstellung wie System','Sprache auf Englisch umstellen'])assert.ok(german.includes(text),`German frame shows ${text}`);
// The head names the real roles of the viewer, never a static label.
const roles=value=>[{roles:['Owner']},{roles:['Auditors','Operators']},{roles:[]},{}].map(extra=>render(inLocale(value,h(shell.AccountMenu,{viewer:{...viewer,...extra},saving:false,onAccount:noop,onSignOut:noop,open:true}))).match(/<small class="sdx-account-roles">([^<]+)<\/small>/)[1]);
assert.deepEqual(roles('en'),['Owner','Auditors, Operators','No role','No role']);
assert.deepEqual(roles('de'),['Owner','Auditors, Operators','Keine Rolle','Keine Rolle']);
const empty=render(inLocale('en',h(CommandPalette,{open:true,onOpenChange:noop,getItems:()=>[]})));
assert.ok(empty.includes('No results for “”.'),'the empty palette names the query in English');
checks+=6;

// Every help topic in English has no German and the same shape as in German.
// The topics are those of the nodes of the navigation model (ui/shell/nav-model.ts).
const {navNodes}=await import('../../ui/shell/nav-model.ts');
let topics=0;
for(const node of navNodes){
 const route={...node.route,...(node.route.view==='device'?{deviceId:'d1'}:{})},english=topicFor(route,'en'),german=topicFor(route);
 assert.deepEqual(germanIn([english.title,...english.tips,...english.docs.map(item=>item.label)].join('\n')),[],node.id);
 assert.equal(english.tips.length,german.tips.length);assert.deepEqual(english.docs.map(item=>item.file),german.docs.map(item=>item.file));
 assert.ok(english.tips.every(tip=>!tip.includes('!')),'no exclamation marks');
 topics++;
}
assert.ok(topics>80,"every node has a topic");
for(const item of shortcutList)for(const value of locales){
 for(const key of [item.label,item.scope].filter(Boolean)){const text=translate(value,key);assert.ok(text&&text!==key,`${key} in ${value}`);if(value==='en')assert.deepEqual(germanIn(text),[],key);}
}
assert.ok(shortcutList.some(item=>item.keys.includes(shortcutOr)),'"or" is a message key, not a key cap');
checks+=4;

// module-level text holds keys.
const isKey=value=>Object.hasOwn(en,value);
assert.ok(isKey(theme.themeHeading)&&isKey(theme.themePaletteGroup)&&theme.themeOptions.every(option=>isKey(option.label)&&isKey(option.action)),'theme texts are keys');
assert.ok(shortcutList.every(item=>isKey(item.label)&&(!item.scope||isKey(item.scope))),'shortcut texts are keys');
// The navigation model holds message keys: labels, hints, subtitles, titles, groups and palette labels.
{
 const texts=navNodes.flatMap(node=>[node.label,node.hint,node.subtitle,node.title,node.placement.group,node.palette?.label,...(node.palette?.hint??[]),node.palette?.keywordsKey,node.shortcut?.label].filter(Boolean));
 assert.ok(texts.length>100,'the model has texts');
 assert.deepEqual(texts.filter(text=>!isKey(text)),[],'every text of the navigation model is a message key');
}
assert.deepEqual(theme.themePaletteItems(noop).map(item=>item.label),['Light appearance','Dark appearance','Appearance: match system'],'English by default');
assert.deepEqual(theme.themePaletteItems(noop,'de').map(item=>item.label),['Helle Darstellung','Dunkle Darstellung','Darstellung wie System']);
assert.deepEqual(theme.themePaletteItems(noop,'en').map(item=>item.label),['Light appearance','Dark appearance','Appearance: match system']);
checks+=7;

// No German text and no fixed-locale formatting outside the catalog; German lives in de.ts.
// The guard walks every .ts and .tsx file under app/ and components/, so a new file
// with German fails without a list entry. translatedFiles holds the lib/ files: the
// translated UI helpers and the error contract.
export {translatedFiles};
const stripComments=text=>text.replace(/\/\*[\s\S]*?\*\//g,'').replace(/(^|[^:'"`])\/\/[^\n]*/g,'$1');
const literalsOf=text=>[...text.matchAll(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`|>([^<>{}]+)</g)].map(match=>match[1]??match[0]);
const fixedFormat=/'de-DE'|\.toLocale(?:Date|Time)?String\(|new Intl\.(?:Number|DateTime)Format\(|\.toLocale(?:Lower|Upper)Case\(\s*(['"])de\1\s*\)/;
const scanSource=source=>{const text=stripComments(source),found=germanIn(literalsOf(text).join('\n')).filter(word=>word!=='umlaut');if(/[äöüÄÖÜß]/.test(text))found.push('umlaut');const format=text.match(fixedFormat);if(format)found.push(format[0]);return found;};
// Three models moved from lib/ (outside translatedFiles) to ui/ with lib/server/, and this guard never scanned
// them: the German sample device data (ui/shell/demo.ts), the stored German audit texts that
// ui/devices/history/audit-display.ts maps, and the abort reason of ui/devices/remote/terminal-session-discovery.ts.
const germanData=new Set(['ui/shell/demo.ts','ui/devices/history/audit-display.ts','ui/devices/remote/terminal-session-discovery.ts']);
const guardedFiles=[...walk('app'),...walk('ui')].filter(file=>!germanData.has(file));
// app/ and components/ hold about 175 source files today; with the lib files the guard scans more than 200.
assert.ok(guardedFiles.length>150&&guardedFiles.length+translatedFiles.length>200,'the walk finds every app and component file');
assert.ok(guardedFiles.includes('app/api/console/route.ts')&&guardedFiles.includes('app/Agent-v3-release.json/route.ts')&&guardedFiles.includes('app/downloads/[file]/route.ts'),'the walk covers the API routes');
assert.ok(translatedFiles.every(file=>/^(?:lib|ui)\//.test(file))&&translatedFiles.length>=20,'translatedFiles holds the lib files and the UI models that moved from lib/ to ui/');
for(const file of [...guardedFiles,...translatedFiles]){
 let source;try{source=read(file);}catch{assert.fail(`${file} from translatedFiles exists`);}
 assert.deepEqual(scanSource(source),[],`${file} has no German UI text, no umlaut and no fixed-locale formatting`);
}
// The scanner itself: it flags German literals, JSX text and fixed-locale calls, not collation.
for(const sample of ["const x='Keine Aufträge.';",'const y="Abbrechen";','<b>Gruppe erstellen</b>',"value.toLocaleString('de-DE')","link.download=name||'ServerDesk-Datei';","downloadText('ServerDesk-Netzwerkdiagnose.json',text);","downloadText('ServerDesk-Netzwerk-'+name+'.json',text);","meta={`${count} gemeldet`}","user.mfaEnabled?'MFA eingerichtet':label","const file='ServerDesk-GERAET.registration.json';","query.toLocaleLowerCase('de')","name.toLocaleUpperCase(\"de\")"])assert.notDeepEqual(scanSource(sample),[],`the guard flags ${sample}`);
assert.deepEqual(scanSource('query.toLocaleLowerCase(locale)'),[],'lower-casing in the console locale is no fixed format');
assert.deepEqual(scanSource("list.sort((a,b)=>a.localeCompare(b,'de'));"),[],'collation is no display');
assert.ok(!read('ui/kit/kit.tsx').includes("'de-DE'"),"kit.tsx has no 'de-DE'");
{const literals=[...stripComments(read('lib/i18n/messages/de.ts')).matchAll(/'(?:[^'\\\n]|\\.)*'/g)].map(match=>match[0]);assert.ok(germanIn(literals.join('\n')).length>=10,'the source scan recognizes German literals');}
checks+=2;

// The hooks of ui/base/locale.tsx run only on the client. A file without
// 'use client' renders as a server component when a server page imports it, and
// the hook call then fails with HTTP 500 (as /remote-desktop did with RdpPaused).
const callsClientI18nHook=source=>/(?<![\w$])(?<!function\s+)(?:useT|useStableT|useLocale)\(/.test(stripComments(source));
const startsWithUseClient=source=>/^(['"])use client\1/.test(source.replace(/^(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*/,''));
const hookCallers=[...walk('app'),...walk('ui'),...walk('lib')].filter(file=>callsClientI18nHook(read(file)));
assert.ok(hookCallers.includes('ui/devices/remote/remote-desktop-paused.tsx')&&hookCallers.includes('ui/session/session-card.tsx')===false&&hookCallers.includes('ui/session/identity-change-gate.tsx'),'the scan finds the client-only i18n hook callers');
for(const file of hookCallers)assert.ok(startsWithUseClient(read(file)),`${file} calls a client-only i18n hook (useT, useStableT or useLocale) without the 'use client' directive`);
// The rule itself: calls count, imports and comments do not; leading comments may precede the directive.
assert.ok(callsClientI18nHook("const t=useT();")&&callsClientI18nHook("const [locale]=useLocale();")&&callsClientI18nHook("const t=useStableT();"),'the guard sees each hook call');
assert.ok(!callsClientI18nHook("import {useT} from '@/ui/base/locale';\n// useT() in a comment\nexport function useT(){}"),'imports, comments and the definition are no calls');
assert.ok(startsWithUseClient("// Header.\n/* More. */\n'use client';\nconst t=useT();")&&startsWithUseClient('"use client";'),'leading comments are allowed');
assert.ok(!startsWithUseClient(read('ui/devices/remote/remote-desktop-paused.tsx').replace(/^'use client';/,''))&&!startsWithUseClient("const a=1;\n'use client';"),'a missing or late directive fails');
checks+=1;

// The docs section.
const docs=read('../CONTRIBUTING.md');
const section=docs.slice(docs.indexOf('## Translations'));
assert.ok(docs.includes('## Translations'),'docs section');
for(const word of ['serverdesk-locale','<html lang>','lib/i18n/messages/en.ts','lib/i18n/messages/de.ts','tsc','{count}','format.ts','tests/repo/i18n.mjs','formatNumber','formatDate','formatTime','translatedFiles'])assert.ok(section.includes(word),`docs mention ${word}`);
checks+=2;

// Kit foundations II: the pagination and removal keys in both catalogs, the old removal labels gone.
for(const key of ['kit.pagination.label','kit.pagination.range','kit.pagination.previous','kit.pagination.next','kit.pagination.first','kit.pagination.last','console.removal.bulkButton','console.removal.uninstallButton','console.removal.deviceLabel','console.removal.devicesLabel','console.removal.ownerOnly'])assert.ok(key in en&&key in de,key+' in both catalogs');
for(const key of ['device.offboard','fleet.menu.removeFromPortal'])assert.ok(!(key in en)&&!(key in de),key+' is removed');
assert.deepEqual([translate('en','console.removal.bulkButton',{count:1}),translate('en','console.removal.bulkButton',{count:3}),translate('de','console.removal.bulkButton',{count:1}),translate('de','console.removal.bulkButton',{count:3})],['Remove device','Remove 3 devices','Gerät entfernen','3 Geräte entfernen'],'the plural forms of the bulk button');
assert.deepEqual([translate('en','kit.pagination.range',{start:'1',end:'50',total:'312'}),translate('de','kit.pagination.range',{start:'1',end:'50',total:'312'})],['1–50 of 312','1–50 von 312']);
assert.equal(en['console.removal.button'],'Remove device');assert.equal(de['console.removal.button'],'Gerät entfernen');
checks+=5;

// Slice 4 of the UI rework: the rail without Agents and with the kit Tooltip, the crumb button, the new and removed keys, and no old page name in the catalogs.
{
 for(const value of ['en','de']){
  const rail=render(inLocale(value,h(shell.Rail,{items:railItems(value),area:'settings'})));
  assert.ok(!/ title=/.test(rail),value+': the rail markup has no title attribute');
  assert.equal((rail.match(/aria-current="page"/g)??[]).length,1,value+': the active item keeps aria-current');
  assert.deepEqual([...rail.matchAll(/class="sdx-rail-label">([^<]+)</g)].map(match=>match[1]),value==='en'?['Devices','Automation','Settings']:['Geräte','Automation','Einstellungen'],value+': Devices, Automation, Settings');
  const area=translate(value,'nav.settings.title'),header=render(inLocale(value,h(shell.PageHeader,{title:translate(value,'nav.settings.sessions'),areaCrumb:{label:area,expanded:false,onSelect:noop}})));
  assert.match(header,new RegExp('aria-label="'+translate(value,'shell.areaPages',{area})+'"'),value+': the crumb button is named by shell.areaPages');
  assert.match(header,/aria-expanded="false"/,value+': aria-expanded');
  assert.match(header,/class="sdx-page-path sdx-page-path-area"/,value+': in the crumb row that CSS hides above 900px');
 }
 assert.deepEqual([kit.iconButtonTip(translate('en','rail.settings'),'G S',translate('en','kit.ctrl')),kit.iconButtonTip(translate('de','rail.settings'),'G S',translate('de','kit.ctrl'))],['Settings (G S)','Einstellungen (G S)'],'the rail tooltip text');
 const added={'nav.settings.groupIntegrations':['Integrations','Integrationen'],'nav.settings.groupAgents':['Agents','Agents'],'nav.settings.groupSystem':['System','System'],'shell.areaPages':['Show pages: {area}','Seiten anzeigen: {area}'],'nav.settings.groupUsers':['Accounts & access','Konten & Zugriff'],'nav.settings.sessions':['Sessions','Sitzungen'],'nav.settings.retention':['Data retention','Datenaufbewahrung'],'nav.settings.usageData':['Usage data','Nutzungsdaten'],'nav.settings.notificationChannels':['Notification channels','Benachrichtigungskanäle'],'nav.settings.audit':['Audit log','Audit-Protokoll'],'nav.settings.agentTroubleshooting':['Agent troubleshooting','Agent-Fehlersuche'],'access.auditLoading':['Loading audit log','Audit-Protokoll wird geladen'],'shortcuts.devices':['All devices','Alle Geräte']};
 for(const [key,[english,german]] of Object.entries(added))assert.deepEqual([en[key],de[key]],[english,german],key);
 for(const key of ['rail.agents','nav.agents.title','nav.access.groupPortal','nav.agents.uninstall','nav.agents.uninstallHint','palette.action.addDevice'])assert.ok(!(key in en)&&!(key in de),key+' is removed');
 assert.deepEqual(Object.keys(en).filter(key=>key.startsWith('palette.page.')),[],'no palette.page key is left');
 // "Portal log" as a word: "Portal login" (help.doc.portalSessions) is another thing.
 const old=/Portal log\b|portal log\b|Portalprotokoll|Settings → License|Settings → Maintenance|Settings → Security|Settings → Notifications|Users & access|Benutzer & Rechte|Einstellungen → Lizenz|Einstellungen → Wartung|Einstellungen → Sicherheit/;
 const hits=['lib/i18n/messages/en.ts','lib/i18n/messages/de.ts'].flatMap(file=>readFileSync(file,'utf8').split(/\r?\n/).map((line,index)=>old.test(line)?file+':'+(index+1):null).filter(Boolean));
 assert.deepEqual(hits,[],'no old page name in the catalogs');
 assert.deepEqual([en['usage.consentNo'],de['usage.consentNo']].map(text=>/Settings → Usage data|Einstellungen → Nutzungsdaten/.test(text)),[true,true],'the usage data consent names the page Usage data');
 checks+=6;
}

// UI-Rework 8 (Accounts, User groups, Roles and the Permissions view): the new and changed keys in both catalogs, and the
// keys nothing reads anymore are gone.
{
 const rbacKeys={"rbac.assignRole": ["Assign role", "Rolle zuweisen"], "rbac.menu.assignRole": ["Assign role…", "Rolle zuweisen…"], "rbac.menu.editAccount": ["Edit account…", "Konto bearbeiten…"], "rbac.menu.passwordLink": ["Create password link…", "Passwortlink erstellen…"], "rbac.menu.disableAccount": ["Deactivate account…", "Konto deaktivieren…"], "rbac.menu.enableAccount": ["Activate account…", "Konto aktivieren…"], "rbac.menu.editGroup": ["Edit user group…", "Benutzergruppe bearbeiten…"], "rbac.menu.disableGroup": ["Deactivate user group…", "Benutzergruppe deaktivieren…"], "rbac.menu.enableGroup": ["Activate user group…", "Benutzergruppe aktivieren…"], "rbac.menu.deleteGroup": ["Delete user group…", "Benutzergruppe löschen…"], "rbac.menu.removeMember": ["Remove member…", "Mitglied entfernen…"], "rbac.menu.editRole": ["Edit role…", "Rolle bearbeiten…"], "rbac.menu.deleteRole": ["Delete role…", "Rolle löschen…"], "rbac.menu.removeAssignment": ["Remove assignment…", "Zuweisung entfernen…"], "rbac.menu.openOrigin": ["Open origin", "Ursprung öffnen"], "rbac.disableAccount.confirm": ["Deactivate account", "Konto deaktivieren"], "rbac.enableAccount.confirm": ["Activate account", "Konto aktivieren"], "rbac.passwordLink.confirm": ["Create password link", "Passwortlink erstellen"], "rbac.group.disable.confirm": ["Deactivate user group", "Benutzergruppe deaktivieren"], "rbac.group.enable.confirm": ["Activate user group", "Benutzergruppe aktivieren"], "rbac.group.delete.confirm": ["Delete user group", "Benutzergruppe löschen"], "rbac.member.remove.confirm": ["Remove member", "Mitglied entfernen"], "rbac.role.delete.confirm": ["Delete role", "Rolle löschen"], "rbac.openGroup": ["Open user group {name}", "Benutzergruppe {name} öffnen"], "rbac.openRole": ["Open role {name}", "Rolle {name} öffnen"], "rbac.col.members": ["Members", "Mitglieder"], "rbac.col.type": ["Type", "Typ"], "rbac.col.permissions": ["Permissions", "Berechtigungen"], "rbac.foot.accounts": [{"one": "{shown} of 1 account", "other": "{shown} of {count} accounts"}, {"one": "{shown} von 1 Konto", "other": "{shown} von {count} Konten"}], "rbac.foot.groups": [{"one": "{shown} of 1 user group", "other": "{shown} of {count} user groups"}, {"one": "{shown} von 1 Benutzergruppe", "other": "{shown} von {count} Benutzergruppen"}], "rbac.foot.roles": [{"one": "{shown} of 1 role", "other": "{shown} of {count} roles"}, {"one": "{shown} von 1 Rolle", "other": "{shown} von {count} Rollen"}], "rbac.groups.noneHint": ["A user group gives the same roles to several accounts at once.", "Eine Benutzergruppe gibt mehreren Konten auf einmal dieselben Rollen."], "rbac.group.membersTitle": ["Members", "Mitglieder"], "rbac.group.addTitle": ["Add member", "Mitglied hinzufügen"], "rbac.group.pickLabel": ["Accounts that are not members", "Konten, die nicht Mitglied sind"], "rbac.group.noCandidates":["Every active account is already a member","Jedes aktive Konto ist schon Mitglied"], "rbac.role.readOnly": ["Built-in roles cannot be changed. Create a role to choose your own permissions.", "Integrierte Rollen kannst du nicht ändern. Erstelle eine Rolle, um eigene Berechtigungen zu wählen."], "rbac.blocked.loading": ["Wait until the list has loaded.", "Warte, bis die Liste geladen ist."], "rbac.blocked.right":["You don't have permission to make this change.","Dir fehlt die Berechtigung für diese Änderung."], "rbac.blocked.ownAccount": ["You cannot deactivate your own account.", "Dein eigenes Konto kannst du nicht deaktivieren."], "rbac.blocked.passwordLinkDisabled": ["Activate the account first. A deactivated account gets no password link.", "Aktiviere das Konto zuerst. Ein deaktiviertes Konto erhält keinen Passwortlink."], "rbac.blocked.assignDisabled": ["Activate the account first. A deactivated account gets no role.", "Aktiviere das Konto zuerst. Ein deaktiviertes Konto erhält keine Rolle."], "rbac.blocked.assignRight":["You don't have permission to manage role assignments.","Dir fehlt die Berechtigung, Rollenzuweisungen zu verwalten."], "rbac.blocked.assignDemo": ["End the sample devices to assign a role.", "Beende die Beispielgeräte, um eine Rolle zuzuweisen."], "rbac.blocked.nameMissing": ["Enter a name.", "Gib einen Namen ein."], "rbac.blocked.usernameInvalid":["Enter a username with 3 to 64 characters: letters, digits and . _ @ + -.","Gib einen Benutzernamen mit 3 bis 64 Zeichen ein: Buchstaben, Ziffern und . _ @ + -."], "rbac.blocked.noPermission": ["Choose at least one permission.", "Wähle mindestens eine Berechtigung."], "rbac.toast.groupCreated": ["User group created.", "Benutzergruppe erstellt."], "rbac.toast.roleCreated": ["Role created.", "Rolle erstellt."], "rbac.link.copied": ["Activation link copied.", "Aktivierungslink kopiert."], "nav.settings.rolesHint": ["A role is a set of permissions. Assign roles to accounts and user groups to decide what they can see and change.", "Eine Rolle ist eine Sammlung von Berechtigungen. Weise Rollen Konten und Benutzergruppen zu, um festzulegen, was sie sehen und ändern dürfen."], "rbac.accountRightsHint":["A new account has no permissions. After you create it, assign a role with “Assign role”.","Ein neues Konto hat keine Berechtigungen. Weise ihm nach dem Erstellen mit „Rolle zuweisen“ eine Rolle zu."], "rbac.toast.userCreated":["Account created. Assign a role so that it gets permissions.","Konto erstellt. Weise eine Rolle zu, damit es Berechtigungen erhält."], "rbac.toast.assignmentSaved": ["Role assigned.", "Rolle zugewiesen."], "rbac.role.removeAssignmentsFirst": ["The role is still assigned. Remove its assignments first.", "Die Rolle ist noch zugewiesen. Entferne zuerst ihre Zuweisungen."], "rbac.group.assignmentRight":["This group has roles. To change it, you also need the permission to manage role assignments.","Diese Gruppe hat Rollen. Um sie zu ändern, brauchst du zusätzlich die Berechtigung, Rollenzuweisungen zu verwalten."], "rbac.passwordLink.title": ["Create a new password link?", "Neuen Passwortlink erstellen?"], "rbac.dialog.accountHint":["The person sets their own password with a one-time activation link.","Die Person legt ihr Passwort selbst mit einem einmaligen Aktivierungslink fest."], "help.access.tip1": ["Assign a role from the menu of an account in “Accounts”. A role applies to all devices, a device group or one device.", "Weise eine Rolle über das Menü eines Kontos unter „Konten“ zu. Eine Rolle gilt für alle Geräte, eine Gerätegruppe oder ein Gerät."]};
 for(const [key,[english,german]] of Object.entries(rbacKeys))assert.deepEqual([en[key],de[key]],[english,german],key);
 for(const key of ['rbac.refresh','rbac.copyFailed','rbac.editAccount','rbac.passwordLinkFor','rbac.removeAssignmentFor','rbac.group.newMember','rbac.group.disable','rbac.group.enable','rbac.group.assignmentRightNotice','rbac.member.removeFrom','rbac.group.choose','rbac.role.edit','rbac.role.delete','rbac.role.showPermissions','rbac.contactEmail','rbac.groupName','rbac.roleName','rbac.roleOwner','rbac.link.label','rbac.membersDisabled'])assert.ok(!(key in en)&&!(key in de),key+' is removed');
 checks+=2;
}

// Branding 3/4 (device type, manufacturer logos, pinned devices, density): the new keys in both catalogs with their
// texts, and no emoji (no code point in \p{Extended_Pictographic}) in the new keys, the logo docs and the vendored data.
{
 const brandingKeys={
  'deviceType.label':['Device type','Gerätetyp'],'deviceType.server':['Server','Server'],'deviceType.domainController':['Domain controller','Domänencontroller'],
  'deviceType.laptop':['Laptop','Laptop'],'deviceType.workstation':['Workstation','Arbeitsplatzrechner'],'deviceType.unknown':['Device type not reported yet','Gerätetyp noch nicht gemeldet'],
  'fleet.col.manufacturer':['Manufacturer','Hersteller'],'csv.deviceType':['Device type','Gerätetyp'],'csv.manufacturer':['Manufacturer','Hersteller'],'csv.model':['Model','Modell'],
  'pins.title':['Pinned','Angeheftet'],'pins.pin':['Pin device','Gerät anheften'],'pins.unpin':['Unpin device','Gerät lösen'],'pins.pinned':['Device pinned.','Gerät angeheftet.'],
  'pins.unpinned':['Device unpinned.','Gerät gelöst.'],'pins.keywords':['pin unpin favorite favourite pinned','anheften lösen favorit favoriten angeheftet'],
  'density.heading':['Density','Darstellungsdichte'],'density.comfortable':['Comfortable','Komfortabel'],'density.compact':['Compact','Kompakt'],
  'density.hint':['Compact fits more rows on the screen, except on touch screens and in narrow windows.','Kompakt zeigt mehr Zeilen auf dem Bildschirm, außer auf Touchscreens und in schmalen Fenstern.'],
  'palette.action.densityCompact':['Use compact density','Kompakte Darstellung verwenden'],'palette.action.densityComfortable':['Use comfortable density','Komfortable Darstellung verwenden'],
  'apiError.account.pinLimit':['You can pin up to {max} devices. Unpin a device, then try again.','Du kannst bis zu {max} Geräte anheften. Löse ein Gerät und versuche es erneut.'],
 };
 for(const [key,[english,german]] of Object.entries(brandingKeys))assert.deepEqual([en[key],de[key]],[english,german],key);
 const pictographic=/\p{Extended_Pictographic}/u;
 for(const [key] of Object.entries(brandingKeys))for(const text of [en[key],de[key]])assert.doesNotMatch(text,pictographic,`${key} has no emoji`);
 for(const file of ['docs/manufacturer-logos.md','ui/devices/hardware/manufacturer-logos.ts','ui/devices/hardware/manufacturer-model.ts'])assert.doesNotMatch(read(file),pictographic,`${file} has no emoji`);
 checks+=3;
}

// The Dashboard (docs/dashboard.md): the name of the page and its key texts in both catalogs, the name and the
// one-line description of every widget, every dashboard.* key used by the page, the plural forms of the counted
// sentences, the names the edit controls give a widget, and no emoji in the keys and docs.
{
 const dashboardKeys={
  'rail.dashboard':['Dashboard','Dashboard'],'shortcuts.dashboard':['Dashboard','Dashboard'],'startPage.dashboard':['Dashboard','Dashboard'],'help.dashboard.title':['Dashboard','Dashboard'],'help.doc.dashboard':['Dashboard','Dashboard'],
  'palette.action.startDashboard':['Start page: Dashboard','Startseite: Dashboard'],'palette.action.customizeDashboard':['Customize dashboard','Dashboard anpassen'],
  'dashboard.subtitle':['What needs your attention now.','Was jetzt deine Aufmerksamkeit braucht.'],
  'dashboard.status.fine':['Everything is running','Alles läuft'],
  'dashboard.widget.alarms':['Open alarms','Offene Alarme'],'dashboard.widget.offline':['Offline devices','Geräte offline'],'dashboard.widget.updates':['Updates due','Fällige Updates'],
  'dashboard.widget.jobs':['Recent jobs','Letzte Aufträge'],'dashboard.widget.alarmWeek':['Alarms in the last 7 days','Alarme der letzten 7 Tage'],
  'dashboard.widget.health':['Device health','Gerätegesundheit'],'dashboard.widget.diskSpace':['Disk space','Speicherplatz'],'dashboard.widget.defender':['Microsoft Defender','Microsoft Defender'],
  'dashboard.widget.certificates':['Certificates','Zertifikate'],'dashboard.widget.failedJobs':['Failed jobs','Fehlgeschlagene Aufträge'],'dashboard.widget.activity':['Recent activity','Letzte Aktivität'],
  'dashboard.alarms.empty':['No open alarms','Keine offenen Alarme'],'dashboard.offline.empty':['All devices are online','Alle Geräte sind online'],'dashboard.updates.empty':['No updates due','Keine fälligen Updates'],
  'dashboard.jobs.empty':['No jobs yet','Noch keine Aufträge'],'dashboard.week.empty':['No alarms in the last 7 days','Keine Alarme in den letzten 7 Tagen'],
  'dashboard.devices.show':['Show devices','Geräte anzeigen'],'dashboard.customize':['Customize','Anpassen'],'dashboard.default.edit':['Edit default layout','Standard-Anordnung bearbeiten'],
  'dashboard.edit.add':['Add widget…','Widget hinzufügen…'],'dashboard.catalog.title':['Add widget','Widget hinzufügen'],'dashboard.empty.board':['No widgets on your dashboard','Keine Widgets auf deinem Dashboard'],
  'dashboard.layout.reset':['Reset to default','Auf Standard zurücksetzen'],'dashboard.layout.saved':['Layout saved.','Anordnung gespeichert.'],'dashboard.default.saved':['Default layout saved.','Standard-Anordnung gespeichert.'],
  'audit.action.dashboard.default.set':['Default dashboard layout changed','Standard-Anordnung des Dashboards geändert'],'audit.action.dashboard.default.remove':['Default dashboard layout reset','Standard-Anordnung des Dashboards zurückgesetzt'],
 };
 for(const [key,[english,german]] of Object.entries(dashboardKeys))assert.deepEqual([en[key],de[key]],[english,german],key);
 assert.deepEqual([1,3].map(count=>translate('en','dashboard.status.alarms',{count})),['1 open alarm needs your attention','3 open alarms need your attention']);
 assert.deepEqual([1,3].map(count=>translate('de','dashboard.status.alarms',{count})),['1 offener Alarm braucht deine Aufmerksamkeit','3 offene Alarme brauchen deine Aufmerksamkeit']);
 assert.deepEqual([1,4].map(count=>translate('de','dashboard.status.online',{online:1,count})),['1 von 1 Gerät online','1 von 4 Geräten online']);
 assert.deepEqual([1,2].map(count=>translate('de','dashboard.updates.on',{count})),['auf 1 Gerät','auf 2 Geräten']);
 // A lead number stands before its detail, so the detail agrees with the count without repeating it.
 assert.deepEqual([[1,2].map(count=>translate('en','dashboard.attention',{count})),[1,2].map(count=>translate('de','dashboard.attention',{count})),[1,2].map(count=>translate('de','dashboard.restart.detail',{count})),[1,0].map(count=>translate('en','dashboard.diskSpace.detail',{count}))],
  [['device needs attention','devices need attention'],['Gerät braucht Aufmerksamkeit','Geräte brauchen Aufmerksamkeit'],['Gerät wartet auf einen Neustart','Geräte warten auf einen Neustart'],['drive is at least 90 % full','drives are at least 90 % full']]);
 assert.deepEqual([translate('en','dashboard.edit.move',{name:'Open alarms'}),translate('en','dashboard.edit.resize',{name:'Open alarms'}),translate('en','dashboard.edit.remove',{name:'Open alarms'}),translate('en','dashboard.edit.actions',{name:'Open alarms'}),translate('en','dashboard.catalog.addNamed',{name:'Open alarms'})],
  ['Move Open alarms','Resize Open alarms','Remove Open alarms','Actions for Open alarms','Add Open alarms'],'every edit control names its widget');
 assert.deepEqual([translate('de','dashboard.edit.moved',{name:'Offene Alarme',position:2,total:5}),translate('de','dashboard.edit.resized',{name:'Offene Alarme',width:3,height:2}),translate('en','dashboard.edit.size',{width:3,height:2}),translate('en','dashboard.more',{count:4}),translate('de','dashboard.more',{count:1})],
  ['Offene Alarme ist jetzt Widget 2 von 5.','Offene Alarme hat jetzt die Größe 3 × 2.','3 × 2','4 more','1 mehr']);
 // The page says "widget", never "tile".
 for(const [key,value] of Object.entries(en))if(key.startsWith('dashboard.')||key.startsWith('help.dashboard.'))for(const [locale,text] of [['en',value],['de',de[key]]])assert.doesNotMatch(typeof text==='string'?text:text.one+text.other,/\btiles?\b|Kachel/i,`${key} (${locale}) says widget, not tile`);
 // Every widget has a name without a period and a one-sentence description, in both languages.
 const widgetKeys=Object.keys(en).filter(key=>/^dashboard\.widget\.[a-zA-Z]+$/.test(key)&&!key.endsWith('Hint'));
 assert.equal(widgetKeys.length,24,'24 widgets have a name');
 for(const key of widgetKeys)for(const catalog of [en,de]){assert.doesNotMatch(catalog[key],/[.…]$/,`${key} is a title`);assert.match(catalog[key+'Hint'],/^[^.]+\.$/,`${key}Hint is one sentence`);}
 // Every dashboard.* key is read by the Dashboard files, and every key they read exists.
 const dashboardSource=readdirSync('ui/devices/dashboard').filter(file=>/\.tsx?$/.test(file)).map(file=>read('ui/devices/dashboard/'+file)).join('\n')+read('ui/shell/nav-model.ts')+read('ui/shell/console.tsx');
 const dashboardCatalog=Object.keys(en).filter(key=>key.startsWith('dashboard.'));
 assert.ok(dashboardCatalog.length>=200,'the Dashboard keys are in the catalog');
 assert.deepEqual(dashboardCatalog.filter(key=>!dashboardSource.includes("'"+key+"'")),[],'no unused dashboard.* key');
 const pictographic=/\p{Extended_Pictographic}/u;
 for(const key of [...dashboardCatalog,...Object.keys(dashboardKeys),'help.dashboard.tip1','help.dashboard.tip2','help.dashboard.tip3'])for(const text of [en[key],de[key]])assert.doesNotMatch(typeof text==='string'?text:text.one+text.other,pictographic,`${key} has no emoji`);
 assert.doesNotMatch(read('docs/dashboard.md'),pictographic,'docs/dashboard.md has no emoji');
 checks+=9;
}

console.log(`PASS i18n (${checks} check groups): locale cookie, <html lang>, catalogs, translate, format helpers, language switch, translated frame and guard list.`);
