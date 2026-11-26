// Nodiverna rebrand: product name and logo in the portal UI, while
// technical names (derivation labels, headers, files) stay ServerDesk.
import '../support/register.mjs';
import '../support/german-default.mjs';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,statSync} from 'node:fs';
import path from 'node:path';
import React from 'react';
import {renderToStaticMarkup} from '../support/render-de.mjs';

const read=file=>readFileSync(file,'utf8');
const {productName}=await import('../../lib/brand.ts');
assert.equal(productName,'Nodiverna');

// Inline SVG that only paints with currentColor.
const {BrandMark}=await import('../../ui/kit/brand-mark.tsx');
const mark=renderToStaticMarkup(React.createElement(BrandMark,{size:22}));
for(const part of ['<svg','viewBox="0 0 24 24"','width="22"','height="22"','aria-hidden="true"','focusable="false"','currentColor','stroke-linecap="round"'])assert.ok(mark.includes(part),`BrandMark renders ${part}`);
assert.doesNotMatch(mark,/#[0-9a-f]{3,8}\b/i,'BrandMark has no hex colors');
assert.equal(mark.match(/<circle/g)?.length,4,'one node at each corner of the N');
for(const [,attribute,value] of mark.matchAll(/\b(fill|stroke)="([^"]+)"/g))assert.ok(value==='currentColor'||attribute==='fill'&&value==='none',`${attribute}="${value}" uses currentColor`);

// The topbar shows the new name and logo.
const {Topbar}=await import('../../ui/shell/shell.tsx');
const noop=()=>{};
const topbar=renderToStaticMarkup(React.createElement(Topbar,{viewer:{label:'anna@example.test',username:'anna',displayName:'Anna',permissions:['*']},saving:false,navigatorOpen:true,canToggleNavigator:true,onToggleNavigator:noop,onSearch:noop,onRefresh:noop,loading:false,status:'',onHelp:noop,onAccount:noop,onSignOut:noop}));
assert.ok(topbar.includes('<strong>Nodiverna</strong>'),'topbar wordmark');
assert.ok(topbar.includes('aria-label="Nodiverna Geräteübersicht"'),'topbar link label');
assert.ok(topbar.includes(mark.replace('width="22" height="22"','width="16" height="16"')),'topbar tile holds the 16 px BrandMark');
assert.ok(!topbar.includes('ServerDesk'),'topbar no longer names ServerDesk');
assert.ok(topbar.includes('class="sdx-logo"')&&!topbar.includes('<img'),'without branding the topbar shows the gradient tile and no image');
// With an uploaded logo (docs/branding.md): the two images in place of the tile and the wordmark, the product name stays the link name.
const asset=(slot,type='image/png')=>({url:`/api/branding/portal/${slot}?v=0123456789abcdef`,contentType:type,width:120,height:32,size:2048,updatedAt:1});
const branded=renderToStaticMarkup(React.createElement(Topbar,{viewer:{label:'anna@example.test',username:'anna',displayName:'Anna',permissions:['*']},saving:false,navigatorOpen:true,canToggleNavigator:true,onToggleNavigator:noop,onSearch:noop,onRefresh:noop,loading:false,status:'',onHelp:noop,onAccount:noop,onSignOut:noop,logo:{light:asset('light'),dark:asset('dark','image/svg+xml')}}));
assert.equal(branded.match(/<img [^>]*alt=""/g)?.length,2,'two decorative images');
for(const slot of ['light','dark'])assert.ok(branded.includes(`src="/api/branding/portal/${slot}?v=0123456789abcdef"`),`the ${slot} asset URL`);
assert.ok(!branded.includes('class="sdx-logo"')&&!branded.includes('<strong>Nodiverna</strong>'),'no gradient tile and no wordmark beside the logo');
assert.ok(branded.includes('aria-label="Nodiverna Geräteübersicht"'),'the link keeps the product name');
assert.doesNotMatch(read('ui/shell/shell.tsx'),/ServerIcon/);

// The session screens share one frame (SessionCard) with the new brand.
const sessionCard=read('ui/session/session-card.tsx');
assert.ok(sessionCard.includes('<span className="sdx-branding-fade"><BrandMark size={22}/></span><strong className="sdx-branding-fade">{productName}</strong>'),'the session card shows the new brand without a logo');
assert.ok(sessionCard.includes('<BrandLogo light={logo.light} dark={logo.dark} size="session"/><i aria-hidden="true"/><strong>{productName}</strong>'),'with a portal logo the product name stays beside it');
const {SessionBrand}=await import('../../ui/session/session-card.tsx');
const brandRow=branding=>renderToStaticMarkup(React.createElement(SessionBrand,{branding}));
assert.ok(brandRow({loaded:true,portal:{light:asset('light'),dark:null,icon:null}}).includes('<strong>Nodiverna</strong>')&&brandRow({loaded:true,portal:{light:asset('light'),dark:null,icon:null}}).includes('<img'),'the session brand with a logo keeps the product name');
assert.ok(brandRow({loaded:true,portal:null}).includes('<svg')&&!brandRow({loaded:true,portal:null}).includes('<img'),'a failed or empty request shows the Nodiverna mark');
assert.equal(brandRow({loaded:false,portal:null}),'<div class="sd-session-brand"></div>','while loading the row stays empty and keeps its height (session.css)');
// The sign-in background (docs/branding.md): a full-screen decorative cover image and the opaque card; without one,
// after a failed request or when the image fails, the glow canvas stays.
{
 const {SessionScreen,sessionScreenClass}=await import('../../ui/session/session-card.tsx');
 const screen=branding=>renderToStaticMarkup(React.createElement(SessionScreen,{branding,id:'t',title:'Anmelden'},React.createElement('p',null,'Inhalt')));
 const background={kind:'builtin',id:'dune',url:'/backgrounds/dune.svg'};
 const shown=screen({loaded:true,portal:null,signinBackground:background});
 assert.ok(shown.includes('<main class="sd-session-screen sd-session-screen-image sdx-layer"><img class="sd-session-backdrop" src="/backgrounds/dune.svg" alt="" aria-hidden="true" decoding="async"/>'),'the image screen with the cover image before the card');
 assert.ok(shown.includes('<section class="sd-session-card" aria-labelledby="t">'),'the card follows it');
 for(const branding of [{loaded:true,portal:null,signinBackground:null},{loaded:true,portal:null},{loaded:false,portal:null,signinBackground:null}]){
  const plain=screen(branding);
  assert.ok(plain.startsWith('<main class="sd-session-screen sdx-layer"><section')&&!plain.includes('<img'),'without a background (or after a failed request) the glow canvas stays');
 }
 assert.equal(sessionScreenClass(background,true),'sd-session-screen sdx-layer','an image that fails to load drops the image variant');
 assert.ok(sessionCard.includes('onError={()=>setImage({url:background.url,loaded:false,failed:true})}'),'a failed image load is remembered for its URL');
 const css=read('ui/session/session.css');
 assert.match(css,/\.sd-session-screen-image \.sd-session-card\{background:var\(--sd-panel\);-webkit-backdrop-filter:none;backdrop-filter:none\}/,'the card is the opaque panel while a background shows');
 assert.match(css,/@media\(forced-colors:active\)\{\.sd-session-backdrop,\.sd-session-screen-image::before\{display:none\}\}/,'off under forced colors');
 assert.match(css,/\.sd-session-backdrop\[data-loaded\]\{opacity:1;animation:sdx-fade/,'it fades in once loaded');
}
for(const file of ['ui/session/identity-change-gate.tsx','ui/session/identity-entry.tsx','ui/session/session-gate.tsx']){
 const source=read(file);
 assert.ok(source.includes('<SessionCard '),`${file} uses the shared session card`);
 assert.ok(!source.includes('<strong>ServerDesk</strong>'),`${file} drops the old wordmark`);
 assert.doesNotMatch(source,/<Server\b|import \{[^}]*\bServer\b[^}]*\} from 'lucide-react'/,`${file} drops the lucide Server icon`);
}

// Page title and favicon.
const layout=read('app/layout.tsx');
assert.ok(layout.includes('translate(locale, "meta.title")'),'the page title comes from the catalog');
assert.ok(layout.includes('<link rel="stylesheet" href="/api/branding/scheme" data-brand-scheme="" />'),'every page links the brand scheme stylesheet');
assert.ok(layout.includes('icon: "/api/branding/favicon"')&&layout.includes('shortcut: "/api/branding/favicon"'),'the favicon comes from the branding route, which falls back to /favicon.svg');
const favicon=read('public/favicon.svg');
for(const part of ['linearGradient','#7c4dff','#1fb6ff','rx="8"','<circle'])assert.ok(favicon.includes(part),`favicon contains ${part}`);
assert.ok(!favicon.includes('#51d4d0'),'old cyan server icon is gone');

// UI copy. Each entry: old text, new text, files under app/ that hold the new text.
const copy=[
 ['ServerDesk startet das Gerät nicht automatisch neu.','Nodiverna startet es nicht von selbst neu.',['ui/automation/desired-state-components.tsx','ui/automation/desired-state-panel.tsx']],
 ['`ServerDesk · ${server.name}`','`Nodiverna · ${server.name}`',['ui/devices/hardware/device-hardware.tsx']],
 ['ServerDesk in eigenem Tab öffnen','Nodiverna in eigenem Tab öffnen',['ui/account/passkeys-panel.tsx']],
 ['Dein ServerDesk-Konto aktivieren','Dein Nodiverna-Konto aktivieren',[]], // The activation screen is gone.
 ['Bei ServerDesk anmelden','Bei Nodiverna anmelden',['ui/session/identity-entry.tsx']],
 ['wurde zu ServerDesk eingeladen. Lege dein persönliches Passwort fest; danach sicherst du den Zugang mit MFA.','zu Nodiverna eingeladen. Lege dein Passwort fest. Im nächsten Schritt schützt du dein Konto mit MFA.',['ui/session/identity-entry.tsx']],
 ['Verwende deinen ServerDesk-Benutzernamen und dein Passwort. Anschließend bestätigst du deine Anmeldung mit MFA.','Melde dich mit deinem Nodiverna-Benutzernamen und deinem Passwort an. Im nächsten Schritt bestätigst du die Anmeldung mit MFA.',['ui/session/identity-entry.tsx']],
 ['Passkey aus ServerDesk entfernt.','Passkey aus Nodiverna entfernt.',['ui/account/passkeys-panel.tsx']],
 // The passkeys panel reads this note from the catalogs (checked below).
 ['für Microsoft-Entra-Konten, keinen ServerDesk-Passkey.','für Microsoft-Entra-Konten, keinen Nodiverna-Passkey.',[]],
 // The bare literal 'ServerDesk' stays in ui/devices/add-device/agent-guide.ts (event log filter, a technical name), so the badge is matched with its expression.
 // The password row no longer shows a state badge.
 ["{demo?'Demo':'ServerDesk'}","{demo?t('common.demo'):'Nodiverna'}",[]],
 ['Verwende für ServerDesk ein eigenes Passwort.','dieses Passwort nur für Nodiverna.',['ui/account/password-settings.tsx']],
 // The editor hints of the recheck are gone with the embedded transport.
 ['oder öffne ServerDesk in einem eigenen Tab.','oder öffne Nodiverna in einem eigenen Tab.',[]],
 ['Öffne ServerDesk in einem eigenen Tab und prüfe die Verbindung im Editor danach erneut.','Öffne Nodiverna in einem eigenen Tab und prüfe die Verbindung im Editor danach erneut.',[]],
 ['Registriere ein Windows-Gerät mit dem ServerDesk-Agent. Es erscheint hier nach der ersten Meldung.','Installiere mit „Gerät hinzufügen“ den Agent auf einem Windows-Gerät, oder sieh dir zuerst die Beispielgeräte an.',['ui/devices/fleet/fleet.tsx']],
 ['Deine ServerDesk-Anmeldung ist abgelaufen. Bitte erneut mit Benutzername und Passwort anmelden.','Deine Nodiverna-Anmeldung ist abgelaufen. Melde dich erneut mit Benutzername und Passwort an.',['ui/session/session-gate.tsx']],
 ['Füge ServerDesk zu deiner Authenticator-App hinzu und bestätige den angezeigten Code.','Füge Nodiverna zu deiner Authenticator-App hinzu und bestätige den angezeigten Code.',['ui/session/session-gate.tsx']],
 // Every sign-out of the session screens reads "Abmelden" now.
 ['Von ServerDesk abmelden','Von Nodiverna abmelden',[]],
 ['Nach dieser Zeit ohne Eingabe meldet ServerDesk ein Konto ab.','Nodiverna meldet ein Konto nach dieser Zeit ohne Eingabe ab.',['ui/settings/session-settings-panel.tsx']],
 ['ServerDesk kann einmal am Tag ein paar technische Werte','Nodiverna kann einmal am Tag einige technische Werte',['ui/settings/usage-data.tsx']],
 ['ServerDesk-Konto','Nodiverna-Konto',['ui/account/account-panel.tsx']],
 ['Füge ServerDesk in deiner App hinzu und bestätige den neuen Eintrag mit seinem Code.','Füge Nodiverna zu deiner App hinzu und bestätige den neuen Eintrag mit dem angezeigten Code.',['ui/account/account-panel.tsx']],
 ['ServerDesk · Windows PowerShell · SYSTEM','Nodiverna · Windows PowerShell · SYSTEM',['ui/devices/remote/terminal-panel.tsx']],
 // Same sentences in client modules outside the table: the session-lock fallback, passkey errors in a frame, the RDP window.
 ['Deine ServerDesk-Anmeldung ist abgelaufen.','Deine Nodiverna-Anmeldung ist abgelaufen.',['ui/base/http.ts']],
 ['Öffne ServerDesk direkt in einem eigenen Browser-Tab','Öffne Nodiverna direkt in einem eigenen Browser-Tab',['ui/session/passkey-client.ts']],
 ['aus dem ServerDesk-Gerät öffnen','Öffne Remote Desktop über die Geräteseite in Nodiverna',['ui/devices/remote/rdp-bridge.ts']],
];
const sources=dir=>readdirSync(dir).flatMap(name=>{const file=path.join(dir,name);return statSync(file).isDirectory()?sources(file):/\.tsx?$/.test(name)?[file]:[];});
const appSources=[...sources('app'),...sources('ui')].map(file=>[file.replaceAll('\\','/'),read(file)]);
assert.ok(appSources.length>50,'app/ and ui/ sources are found');
// Translated files read their German text from de.ts, so the new sentence is
// either in the file itself or in the German catalog, where a template like
// `Nodiverna · ${server.name}` reads 'Nodiverna · {name}'.
const germanCatalog=read('lib/i18n/messages/de.ts');
const catalogForm=text=>text.replace(/^`|`$/g,'').replace(/\$\{(?:\w+\.)*(\w+)\}/g,'{$1}');
for(const [old,next,files] of copy){
 for(const [file,source] of appSources)assert.ok(!source.includes(old),`${file} still contains "${old}"`);
 assert.ok(!germanCatalog.includes(old),`de.ts still contains "${old}"`);
 for(const file of files)assert.ok(read(file).includes(next)||germanCatalog.includes(catalogForm(next)),`${file} or de.ts contains "${next}"`);
}
assert.ok(read('lib/i18n/messages/de.ts').includes("'passkeys.help.microsoft': 'Microsoft Authenticator unterstützt Passkeys nur für Microsoft-Entra-Konten, nicht für Nodiverna."),'the German passkey note names the product');
assert.ok(read('lib/i18n/messages/en.ts').includes("'passkeys.help.microsoft': 'Microsoft Authenticator supports passkeys only for Microsoft Entra accounts, not for Nodiverna."),'the English passkey note names the product');
assert.ok(read('lib/server/identity/passkeys.ts').includes("new HttpError('apiError.passkey.ownTab',{product:productName})")&&read('lib/i18n/messages/de-server.ts').includes("'apiError.passkey.ownTab': 'Öffne {product} direkt in einem eigenen Browser-Tab, um Passkeys zu verwenden.'"),'passkey frame error names the product');

// Authenticator and passkey display names come from lib/brand.ts.
const mfa=read('lib/server/identity/mfa.ts'),passkeys=read('lib/server/identity/passkeys.ts');
// lib/server/identity/mfa-uri.ts builds both URIs; lib/server/identity/mfa.ts passes the labels.
const mfaUri=read('lib/server/identity/mfa-uri.ts');
assert.equal(mfaUri.match(/&issuer=\$\{encodeURIComponent\(productName\)\}&/g)?.length,1,'the otpauth URI uses the product name as issuer');
assert.ok(mfaUri.includes("import {productName} from '../../brand';"),'lib/server/identity/mfa-uri.ts imports the product name');
assert.equal(mfa.match(/otpauthUri\(productName\+':'\+/g)?.length,2,'both otpauth labels start with the product name');
assert.ok(!mfa.includes('issuer=ServerDesk')&&!mfa.includes("encodeURIComponent('ServerDesk:'"),'no old issuer or label prefix');
assert.ok(passkeys.includes('rpName:productName')&&!passkeys.includes("rpName:'ServerDesk'"),'passkey rpName');
assert.ok(passkeys.includes('rpID:relyingParty().rpID'),'rpID is unchanged');
for(const file of ['lib/server/identity/mfa.ts','lib/server/identity/passkeys.ts'])assert.ok(read(file).includes("import {productName} from '../../brand';"),`${file} imports the product name`);

// Technical names that must stay.
assert.ok(passkeys.includes("'ServerDesk:passkey-user:'"));
assert.ok(read('lib/server/agent/device-tokens.ts').includes("'ServerDesk device access token v1'"));
assert.ok(read('ui/session/session-gate.tsx').includes("'ServerDesk-Recovery-Codes.txt'"),'download file names stay');
console.log('PASS nodiverna brand: product name module, BrandMark, topbar, session screens, title, favicon, UI copy, authenticator/passkey display names and unchanged technical labels.');
