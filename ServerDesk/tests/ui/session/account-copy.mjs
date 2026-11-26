// The copy of the account, sign-in, invitation, MFA and session flows: German texts use the Du-form
// imperative and never "Bitte", "&" stays only in navigation labels and card titles, the help topic
// "My account" says where the preferences are, and the German "…" follows the word directly.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const en=(await import('../../../lib/i18n/messages/en.ts')).default,de=(await import('../../../lib/i18n/messages/de.ts')).default;
const enServer=(await import('../../../lib/i18n/messages/en-server.ts')).default,deServer=(await import('../../../lib/i18n/messages/de-server.ts')).default;
const families=['identity.','session.','account.','passkeys.','password.','mfa.','apiError.auth.','apiError.mfa.','apiError.passkey.','apiError.password.'];
const values=message=>typeof message==='string'?[message]:Object.values(message);

// No "Bitte" in the German texts of these families, in both German catalogs.
const offending=[];
for(const [name,catalog] of [['de.ts',de],['de-server.ts',deServer]])for(const [key,message] of Object.entries(catalog)){
 if(!families.some(prefix=>key.startsWith(prefix)))continue;
 for(const value of values(message))if(/\bbitte\b/i.test(value))offending.push(`${name} ${key}: ${value}`);
}
check(offending,[],'German account, sign-in and session texts use the Du-form imperative, never "Bitte"');
ok(Object.keys(deServer).some(key=>key.startsWith('apiError.mfa.')),'the guard sees the server catalog');
// The rewrites keep the meaning and use the Du-form.
for(const [key,german] of Object.entries({
 'session.endedSignIn':'Deine Sitzung ist beendet. Melde dich erneut an, um weiterzuarbeiten.',
 'session.identityExpired':'Deine Nodiverna-Anmeldung ist abgelaufen. Melde dich erneut mit Benutzername und Passwort an.',
 'identity.sessionInvalid':'Deine Sitzung ist nicht mehr gültig. Prüfe sie erneut.',
 'identity.checkTooLong':'Die Prüfung hat zu lange gedauert. Versuche es erneut.',
 'account.unavailable':'Anmeldemethoden sind derzeit nicht verfügbar. Frag einen Administrator um Hilfe.',
 'passkeys.unavailable':'Passkeys sind derzeit nicht verfügbar. Frag einen Administrator um Hilfe.',
}))check(de[key],german,key);
for(const [key,german] of Object.entries({
 'apiError.auth.finishMfa':'Schließe die Anmeldung mit MFA ab.',
 'apiError.auth.loginRequired':'Melde dich mit Benutzername und Passwort an.',
 'apiError.auth.passwordFirst':'Melde dich zuerst mit Benutzername und Passwort an.',
 'apiError.auth.signInAgain':'Melde dich erneut an.',
 'apiError.mfa.stepUpRequired':'Bestätige deine Identität erneut.',
 'apiError.mfa.proofExpired':'Die Bestätigung ist abgelaufen oder wurde bereits verwendet. Bestätige deine Identität erneut.',
 'apiError.passkey.setUpMfaFirst':'Richte zuerst MFA ein.',
 'apiError.password.common':'Dieses Passwort wird zu häufig verwendet. Wähle eine andere Passphrase.',
}))check(deServer[key],german,key);
ok(Object.keys(enServer).length===Object.keys(deServer).length,'the server catalogs keep their key parity');

// "&" only in navigation labels and card titles; the password section is "Password".
check([en['password.title'],de['password.title']],['Password','Passwort'],'the password section title');
check([en['account.security'],de['account.security']],['Sign-in & security','Anmeldung & Sicherheit'],'the card title keeps "&"');
const ampersands=[];
for(const [name,catalog] of [['en.ts',en],['de.ts',de]])for(const [key,message] of Object.entries(catalog)){
 if(!families.some(prefix=>key.startsWith(prefix))||key==='account.security')continue;
 for(const value of values(message))if(value.includes('&'))ampersands.push(`${name} ${key}: ${value}`);
}
check(ampersands,[],'no other "&" in these families');

// The help topic "My account" says where the preferences are and writes passkey in lower case.
check([en['help.account.tip1'],de['help.account.tip1']],['With a passkey, you sign in without a code. Add a second passkey or an authenticator app as a backup.','Mit einem Passkey meldest du dich ohne Code an. Füge einen zweiten Passkey oder eine Authenticator-App als Reserve hinzu.'],'help tip 1');
check([en['help.account.tip3'],de['help.account.tip3']],['You set the appearance, color scheme, language and start page under “Preferences” on this page.','Darstellung, Farbschema, Sprache und Startseite legst du auf dieser Seite unter „Einstellungen der Oberfläche“ fest.'],'help tip 3 names the Preferences card');
check([en['help.account.tip4'],de['help.account.tip4']],['Appearance and language are also in your account menu at the top right.','Darstellung und Sprache findest du auch im Kontomenü oben rechts.'],'help tip 4 names the account menu');
ok(de['help.account.tip3'].includes(de['account.preferences.title']),'tip 3 uses the German card title');

// Punctuation.
check(de['identity.redirecting'],'Die Microsoft-Anmeldung wird geöffnet…','no space before "…"');
ok(en['passkeys.lastFactor'].endsWith('.')&&de['passkeys.lastFactor'].endsWith('.'),'passkeys.lastFactor ends with a period');
check([en['session.signOut'],de['session.signOut']],[en['shell.signOut'],de['shell.signOut']],'every sign-out reads Sign out / Abmelden');

// The removed keys of the replaced markup are gone from both catalogs.
for(const key of ['shell.role.assigned','account.assignedRoles','account.kind','password.confirmAndChange','account.confirmAndRemove','session.codesSaved','session.idle.inactive','passkeys.refresh','account.authenticatorDemo','account.passkeysDemo','passkeys.demoDisabled'])ok(!(key in en)&&!(key in de),key+' is removed');

console.log(`PASS account copy (${checks} checks): no "Bitte" in the German account, sign-in and session texts, "&" only in card titles, the My account help names the Preferences card, and the punctuation rules hold.`);
