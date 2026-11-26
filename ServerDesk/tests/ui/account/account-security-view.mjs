// My account rendered with React SSR and controlled read states: one SettingsPage with the cards
// Profile, Sign-in & security, the two slots and Preferences; the Entra Profile card with its IDs behind
// "Details"; the Sign-in & security card while loading, after a failed read, unavailable and loaded,
// with its four methods, the protection pill and blocked reasons; sample devices change nothing.
import assert from 'node:assert/strict';
import React from 'react';
import {readFileSync} from 'node:fs';
import {panelHarness} from '../../support/panel-harness.mjs';
let checks=0;
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const h=React.createElement;

let support=null;
const harness=panelHarness({hooked:['ui/account/account-panel.tsx','ui/account/passkeys-panel.tsx','ui/account/password-settings.tsx','ui/shell/page-frame.ts'],stubs:{
 '@/ui/session/passkey-support':{usePasskeySupport:()=>support,DirectTabLink:()=>null},
 '@/ui/session/mfa-qr-code':{default:function MfaQrCode(){return null;}},
}});
const {AccountPanel,ProfileCard,EntraProfileCard,SignInSecurityCard}=harness.load('ui/account/account-panel.tsx');
const PasskeysPanel=harness.load('ui/account/passkeys-panel.tsx').default;
const at=Date.now(),first={id:'one',name:'Mein iPhone',createdAt:at,lastUsedAt:null},second={id:'two',name:'Mein Arbeitsgerät',createdAt:at,lastUsedAt:at};
const base={enabled:true,available:true,authenticated:true,verifiedUntil:at+3600000,passkeyCount:1,authenticatorCount:2,maximumAuthenticators:10,authenticators:[first,second]};
const viewer={id:'owner',label:'owner@example.test',username:'owner',displayName:'Olivia Owner',permissions:['*'],roles:['Operators','Owner']};
const entraViewer={id:'e1',label:'x@tenant.entra.serverdesk.invalid',displayName:'Ada Lovelace',identitySource:'entra',roles:['Owner'],entra:{tenantId:'11111111-2222-4333-8444-555555555555',objectId:'99999999-8888-4777-8666-555555555555',email:'ada@contoso.example'}};
// SignInSecurityCard: 0 status, 6 busy, 7 loading, 8 loadError.
const card=(states={},props={viewer})=>{harness.reset(states);return harness.html(SignInSecurityCard,props);};
const titles=html=>[...html.matchAll(/<h([23])[^>]*>(?:<span[^>]*>(?:(?!<\/span>).)*<\/span>)?([^<]+)<\/h\1>/g)].map(match=>match[2]);
const buttonOf=(html,label)=>html.match(new RegExp(`<button[^>]*>(?:(?!</button>)[\\s\\S])*?<span>${label}</span>[\\s\\S]*?</button>`))?.[0];
const reasonOf=(html,button)=>{const id=button?.match(/aria-describedby="([^"]+)"/)?.[1];return id?html.match(new RegExp(`id="${id}"[^>]*>([^<]*)<`))?.[1]:null;};

// ---- The page: one SettingsPage, the cards in order, no classic markup ----
harness.reset({0:base,7:false});
let html=harness.html(AccountPanel,{viewer,serverSignIns:h('section',{className:'sdx-card'},h('h2',null,'Server-Anmeldungen')),assistantKey:h('section',{className:'sdx-card'},h('h2',null,'KI-Assistent'))});
ok(/^<div class="sdx-settings-page sdx-account"><div class="sdx-settings">/.test(html),'one kit SettingsPage');
const cardTitles=titles(html).filter(title=>['Profil','Anmeldung & Sicherheit','Server-Anmeldungen','KI-Assistent','Einstellungen der Oberfläche'].includes(title.replace('&amp;','&')));
check(cardTitles.map(title=>title.replace('&amp;','&')),['Profil','Anmeldung & Sicherheit','Server-Anmeldungen','KI-Assistent','Einstellungen der Oberfläche'],'Profile, Sign-in & security, Server sign-ins, Personal assistant key, Preferences');
for(const old of ['sdx-account-page','sdx-embedded','class="panel','sd-account-panel','sd-account-profile','sd-account-role','Zugewiesene Rollen','Assigned roles'])ok(!html.includes(old),`no ${old}`);
ok(/class="sdx-account-cards"/.test(html),'the cards sit in the entrance list');
// The entrance is claimed under the id "account": it plays once per page load, a reload of the page data does not replay it.
{const {claimEntrance}=harness.load('ui/kit/kit.tsx');ok(/<EntranceList id="account"/.test(readFileSync('ui/account/account-panel.tsx','utf8')),'the cards rise through EntranceList id="account"');ok(!claimEntrance('account'),'the first render already claimed the entrance, so a later render does not replay it');}

// ---- The page frame (ui/shell/page-frame.ts): the header of the console frame once, at the top of the page ----
{
 let calls=0;const frame={header:primary=>{calls++;return h('header',{className:'test-frame-header'},primary);},refresh:0,tab:'',onTab(){}};
 harness.reset({0:base,7:false});
 const framed=harness.html(AccountPanel,{viewer,frame});
 ok(/^<header class="test-frame-header"><\/header><div class="sdx-settings-page sdx-account">/.test(framed),'the frame header first, then the SettingsPage');
 check([calls,(framed.match(/test-frame-header/g)??[]).length],[1,1],'exactly one header, without a primary');
 harness.reset();calls=0;
 check([/^<header class="test-frame-header">/.test(harness.html(AccountPanel,{viewer:entraViewer,frame})),calls],[true,1],'an Entra account: the same one header');
}

// ---- Profile (local) ----
html=harness.html(ProfileCard,{viewer});
ok(/<span class="sdx-avatar" aria-hidden="true">OO<\/span>/.test(html),'the avatar with initials');
check([...html.matchAll(/<dt>([^<]+)<\/dt><dd>([^<]*)<\/dd>/g)].map(match=>[match[1],match[2]]),[['Name','Olivia Owner'],['Benutzername','owner'],['Anmeldung','Nodiverna-Konto'],['Rollen','Operators, Owner']],'Facts: Name, User name, Sign-in, Roles');
ok(harness.html(ProfileCard,{viewer:{...viewer,roles:[]}}).includes('<dt>Rollen</dt><dd>Keine Rolle</dd>'),'no role: "Keine Rolle"');

// ---- Profile (Entra): one card, IDs behind Details, no methods ----
harness.reset();
html=harness.html(AccountPanel,{viewer:entraViewer});
check((html.match(/<section class="sdx-card/g)??[]).length,2,'two cards: Profile and Preferences');
ok(!/<section class="sdx-card[^>]*>(?:(?!<\/section>)[\s\S])*<section class="sdx-card/.test(html.slice(0,html.indexOf('Einstellungen der Oberfläche'))),'no card is nested in the Profile card');
for(const method of ['Passwort','Passkeys','Authenticator-Apps','Wiederherstellungscodes','Anmeldung &amp; Sicherheit'])ok(!titles(html).includes(method),`Entra: no ${method}`);
html=harness.html(EntraProfileCard,{viewer:entraViewer});
ok(html.includes('Dein Passwort und deine Multi-Faktor-Authentifizierung werden in Microsoft Entra ID verwaltet.'),'the card description');
check([...html.matchAll(/<dt>([^<]+)<\/dt><dd>([^<]*)<\/dd>/g)].map(match=>[match[1],match[2]]).slice(0,4),[['Name','Ada Lovelace'],['E-Mail','ada@contoso.example'],['Anmeldung','Microsoft Entra ID'],['Rollen','Owner']],'Facts: Name, Email, Sign-in, Roles');
const details=html.match(/<details class="sdx-disclosure sdx-account-details"[^>]*>[\s\S]*<\/details>/)?.[0];
ok(details&&!/<details[^>]*\bopen/.test(details)&&details.includes('<strong>Details</strong>'),'a closed Disclosure "Details"');
check([...details.matchAll(/<div class="sdx-copy-value"><code class="mono">([^<]+)<\/code>/g)].map(match=>match[1]),[entraViewer.entra.tenantId,entraViewer.entra.objectId],'tenant and object ID as mono CopyValues');
ok(details.includes('aria-label="Mandanten-ID kopieren"')&&details.includes('aria-label="Objekt-ID kopieren"'),'their copy buttons are named');

// ---- Sign-in & security: loading, failed, unavailable ----
html=card();
ok(/role="status" aria-label="Anmeldemethoden werden geladen"/.test(html)&&html.includes('sdx-skeleton-facts'),'a facts Skeleton while /api/mfa loads');
ok(!html.includes('sdx-pill')&&!/Nicht eingerichtet|Einrichtung erforderlich|0 Passkeys/.test(html),'no state before the read answers');
html=card({7:false,8:'Verbindung fehlgeschlagen.'});
ok(/role="alert">[\s\S]*Verbindung fehlgeschlagen\.[\s\S]*Erneut versuchen/.test(html),'LoadFailed with "Erneut versuchen"');
ok(!/Erneut laden|common\.reload|sd-account-error/.test(html)&&!html.includes('zuletzt geladene'),'no Reload and no stale note without data');
html=card({0:base,7:false,8:'Verbindung fehlgeschlagen.'});
ok(html.includes('Verbindung fehlgeschlagen. Angezeigt wird der zuletzt geladene Stand.')&&html.includes('Mein iPhone'),'with data: the last loaded state stays and the notice says so');
html=card({0:{...base,available:false},7:false});
ok(/sdx-notice-warning[\s\S]*?Anmeldemethoden sind derzeit nicht verfügbar\. Frag einen Administrator um Hilfe\./.test(html),'unavailable: a warning Notice');
ok(/<span class="sdx-pill sdx-pill-neutral"><i aria-hidden="true"><\/i>Nicht verfügbar<\/span>/.test(html),'unavailable: a neutral pill');
ok(!/class="notice|notice amber/.test(html),'no classic notice');

// ---- Loaded: the focal head, the four methods, blocked reasons ----
html=card({0:base,7:false});
ok(/<span class="sdx-pill sdx-pill-success"><i aria-hidden="true"><\/i>Geschützt<\/span>/.test(html),'protected: a success pill in the head');
ok(html.includes('<p class="sdx-section-head-meta">1 Passkey · 2 Authenticator-Apps</p>'),'the meta line counts passkeys and authenticator apps (plural forms)');
ok(card({0:{...base,passkeyCount:2,authenticatorCount:1,authenticators:[first]},7:false}).includes('2 Passkeys · 1 Authenticator-App'),'singular and plural');
const methods=[...html.matchAll(/<section class="sdx-account-method" aria-labelledby="([^"]+)"><header[^>]*><div[^>]*><h3[^>]*><span class="sdx-icon-tile[^"]*"[^>]*><svg[^>]*class="lucide lucide-([a-z-]+)[^>]*>[\s\S]*?<\/svg><\/span>([^<]+)<\/h3>/g)].map(match=>[match[3],match[2]]);
check(methods,[['Passwort','lock'],['Passkeys','fingerprint-pattern'],['Authenticator-Apps','key-round'],['Wiederherstellungscodes','life-buoy']],'Password, Passkeys, Authenticator apps, Recovery codes with their icon tiles');
ok(/<span class="sdx-pill sdx-pill-success sdx-pill-sm"><i aria-hidden="true"><\/i>Aktiv<\/span>/.test(html),'the authenticator state as a small StatusPill (kit variant, no local override)');
ok(!/sdx-btn-primary/.test(html),'no gradient primary inside the card');
ok(html.includes('Mein iPhone')&&html.includes('Mein Arbeitsgerät')&&/aria-label="Aktionen für Mein iPhone"/.test(html),'each authenticator has its row menu');
ok(!/<button[^>]*\sdisabled=""/.test(html),'no native disabled button');
ok(card({0:{...base,enabled:false,authenticatorCount:0,passkeyCount:0,authenticators:[]},7:false}).includes('sdx-pill-warning"><i aria-hidden="true"></i>Einrichtung erforderlich'),'setup required: a warning pill');
// Blocked actions keep their place and say why.
html=card({0:{...base,authenticated:false},7:false});
let button=buttonOf(html,'Passwort ändern');
ok(/aria-disabled="true"/.test(button)&&reasonOf(html,button)==='Bestätige zuerst deine Identität.','Change password waits for the identity confirmation');
ok(/Bestätige deine Identität, um deine Anmeldemethoden zu verwalten\.[\s\S]*Identität bestätigen/.test(html),'the card offers Confirm identity');
html=card({0:{...base,authenticatorCount:10,maximumAuthenticators:10},7:false});
button=buttonOf(html,'Authenticator hinzufügen');
ok(/aria-disabled="true"/.test(button)&&reasonOf(html,button)==='Du kannst bis zu 10 Authenticator-Apps hinzufügen. Entferne zuerst eine.','Add authenticator at the limit');
html=card({0:{...base,enabled:false,authenticatorCount:0,passkeyCount:0,authenticators:[]},7:false});
button=buttonOf(html,'Neue Codes erstellen');
ok(/aria-disabled="true"/.test(button)&&reasonOf(html,button)==='Richte zuerst eine Authenticator-App oder einen Passkey ein.','Create new codes while MFA is off');
// Sample devices change nothing on this page: the card takes no demo flag and loads real data.
html=card({0:base,7:false},{viewer,demo:true});
check(html,card({0:base,7:false}),'demo renders the same real data');
for(const text of ['Authenticator · Demo','Passkeys · Demo','in der Demo deaktiviert'])ok(!html.includes(text),`no "${text}"`);

// ---- Passkeys: loading, failed, unavailable, blocked add ----
const passkeys=(states,props={})=>{harness.reset(states);return harness.html(PasskeysPanel,{mfaEnabled:true,onConfirmIdentity(){},reloadKey:0,...props});};
const keyStatus={available:true,canManage:true,count:1,authenticatorCount:1,passkeys:[{id:'key',name:'Laptop',device:'local',createdAt:at,lastUsedAt:null,backedUp:false,deviceType:'singleDevice'}]};
html=passkeys({});
ok(/role="status" aria-label="Passkeys werden geladen"/.test(html)&&!html.includes('Noch kein Passkey'),'passkeys load with a Skeleton and no false empty state');
html=passkeys({1:false,3:'Passkeys konnten nicht geladen werden.'});
ok(/role="alert">[\s\S]*Passkeys konnten nicht geladen werden\.[\s\S]*Erneut versuchen/.test(html),'a failed passkey read: LoadFailed');
html=passkeys({0:{...keyStatus,available:false},1:false});
ok(/sdx-notice-warning[\s\S]*?Passkeys sind derzeit nicht verfügbar\. Frag einen Administrator um Hilfe\./.test(html),'passkeys unavailable: a warning Notice');
html=passkeys({0:keyStatus,1:false},{mfaEnabled:false});
button=buttonOf(html,'Passkey hinzufügen');
ok(/aria-disabled="true"/.test(button)&&reasonOf(html,button).startsWith('Richte zuerst eine Authenticator-App ein.'),'Add passkey without an authenticator');
support='passkeys.support.browser';html=passkeys({0:keyStatus,1:false});support=null;
button=buttonOf(html,'Passkey hinzufügen');
ok(/aria-disabled="true"/.test(button)&&reasonOf(html,button)==='Dieser Browser unterstützt keine Passkeys. Verwende einen aktuellen Edge, Chrome oder Safari.','Add passkey without browser support');
html=passkeys({0:keyStatus,1:false});
ok(!/aria-disabled/.test(buttonOf(html,'Passkey hinzufügen'))&&html.includes('<p class="sdx-section-head-meta">1 Passkey</p>'),'Add passkey is available; the count is the meta line');
ok(/<details class="sdx-disclosure sdx-account-help"/.test(html)&&html.includes('<strong>Geräte und Apps</strong>'),'the help is a kit Disclosure');
ok(!/class="notice|v3-|sd-passkey-success/.test(html),'no classic notice, v3 class or success line');
html=passkeys({0:{...keyStatus,count:0,passkeys:[]},1:false});
ok(html.includes('Noch kein Passkey hinterlegt.'),'empty: the sentence');

console.log(`PASS account security view (${checks} checks): My account as one SettingsPage with its cards, the local and Entra Profile cards, the Sign-in & security states with skeleton, retry, unavailable notice, protection pill, four methods and blocked reasons, and demo without effect.`);
