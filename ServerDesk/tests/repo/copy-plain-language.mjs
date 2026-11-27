// UI copy, slices 1 to 4 (account, settings, shell, session, device, fleet, Automation, monitoring, audit, extension and
// server message copy): phrases that describe how Nodiverna works inside, or that only add noise, stay out of every
// visible catalog value. Rule: skill nodiverna-ui SKILL.md §5, "Write for the user, not about the system": a help text
// says what a setting changes for the user and when it applies, never which key or rule "takes priority", "wins" or
// "comes first".
// The guard scans every visible key (not *Keywords) of the four catalogs (en.ts holds en-server.ts, de.ts holds
// de-server.ts). The pending list holds the keys that a later copy change still rewrites; each entry must still exist and
// still match, so the change that rewrites a key removes its entry. A new forbidden phrase goes into the pattern lists below.
// Slices 1 to 4 pin their exact copy here: slice 1 the owner's examples (the AI assistant cards, Sessions, the settings
// intros), slice 2 the Move drawer, group deletion, the Tags, Software and Windows Update intros and the assistant drawer,
// slice 3 the Automation inheritance hints, the alert rules intro, the runbook schedule and output texts and the help tips
// that used to state a key order, slice 4 the extension intros, the automation status texts and the Entra MFA error. The
// DHCP and DNS extension result messages (agentMessage.PLUGIN_*) are pinned too: they agree with their portal twins and
// count as "Scopes: {scopes}", never "{scopes} scopes". The test also checks the keys that the slices removed. In the device and fleet copy, every permission named in quotes must
// be the exact label of a permission.*.
import '../support/register.mjs';
import assert from 'node:assert/strict';

let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const en=(await import('../../lib/i18n/messages/en.ts')).default,de=(await import('../../lib/i18n/messages/de.ts')).default;
const enServer=(await import('../../lib/i18n/messages/en-server.ts')).default,deServer=(await import('../../lib/i18n/messages/de-server.ts')).default;
const values=message=>message==null?[]:typeof message==='string'?[message]:[message.one,message.other];

/** English phrases that describe internal design or add filler. */
const englishPatterns=[
 /\bappl(?:y|ies) at once\b/i,
 /\bchanges take effect (?:at once|immediately)\b/i,
 /\btakes? (?:priority|precedence)\b/i,
 /\bpriority over\b/i,
 /\b(?:has|have) none\b/i,
 /\b(?:closest|closer|nearest)\b[^.]*\bwins\b/i,
 /\bcomes first, then\b/i,
];
/** German phrases with the same meaning. */
const germanPatterns=[
 /\b(?:gilt|gelten) sofort\b/i,
 /\bVorrang\b/i,
 /Änderungen werden sofort/i,
 /\bgewinnt\b/i,
 /\bZuerst gilt\b/,
];
const flagged=(text,patterns)=>patterns.some(pattern=>pattern.test(text));

// The patterns flag the owner's examples and accept plain sentences that only share a word.
for(const sample of ['Changes apply at once.','It takes priority over the organization key.','A device policy takes precedence.','Your questions use this key when the device\'s customer has none.','The closest value wins.','A closer tag with the same name wins.','The key of the device\'s customer comes first, then your personal key.'])ok(flagged(sample,englishPatterns),`the English patterns flag "${sample}"`);
for(const sample of ['Änderungen gelten sofort.','Er hat Vorrang vor dem Schlüssel der Organisation.','Der nächste Wert gewinnt.','Zuerst gilt der Schlüssel des Kunden.'])ok(flagged(sample,germanPatterns),`the German patterns flag "${sample}"`);
for(const sample of ['The current secret stops working at once.','Select several devices at once.','This rule applies to the device first.'])ok(!flagged(sample,englishPatterns),`the English patterns accept "${sample}"`);
for(const sample of ['Dieser Schlüssel gilt nur für deine eigenen Fragen.','Der Gewinn'])ok(!flagged(sample,germanPatterns),`the German patterns accept "${sample}"`);

/** Keys that a later copy change still rewrites. Remove an entry when its text is fixed. All four slices are done, so
 *  the lists are empty; a new entry needs a reason, as in 'key':'slice: what still rewrites it'. */
const pending={
 en:{},
 de:{},
};

const catalogs=[['en',en,englishPatterns],['de',de,germanPatterns]];
ok(Object.keys(enServer).every(key=>key in en)&&Object.keys(deServer).every(key=>key in de),'en.ts and de.ts hold the server catalogs, so the scan covers all four');
for(const [language,catalog,patterns] of catalogs){
 const hits=Object.entries(catalog).filter(([key,message])=>!/Keywords$/.test(key)&&values(message).some(text=>flagged(text,patterns))).map(([key])=>key);
 check(hits.filter(key=>!(key in pending[language])),[],`no ${language} value describes internal design or says that changes apply at once`);
 for(const [key,reason] of Object.entries(pending[language])){
  ok(key in catalog,`the pending ${language} key ${key} (${reason}) exists`);
  ok(hits.includes(key),`the pending ${language} key ${key} (${reason}) still matches; remove the entry once its text is fixed`);
 }
}

// The exact copy of slice 1 (the owner's examples and the settings intros), in both languages.
const copy={
 'assistantSettings.personal.text':['The AI assistant answers questions about your devices and helps you troubleshoot. Create an API key at your AI provider and enter it here. This key is only for your own questions. An Owner can add keys for the whole portal or single customers in Settings.','Der KI-Assistent beantwortet Fragen zu deinen Geräten und hilft dir bei der Fehlersuche. Erstelle bei deinem KI-Anbieter einen API-Schlüssel und trage ihn hier ein. Dieser Schlüssel gilt nur für deine eigenen Fragen. Ein Owner kann in den Einstellungen Schlüssel für das ganze Portal oder für einzelne Kunden hinterlegen.'],
 'assistantSettings.organization.text':['With this key, everyone who can view a device can ask the AI assistant about it. Create an API key at your AI provider and enter it here. Questions that use this key are billed to this provider account. You can add keys for single customers below, and each person can add their own key in My account.','Mit diesem Schlüssel kann jede Person, die ein Gerät sehen darf, den KI-Assistenten dazu fragen. Erstelle bei deinem KI-Anbieter einen API-Schlüssel und trage ihn hier ein. Fragen mit diesem Schlüssel rechnet der Anbieter über dieses Konto ab. Schlüssel für einzelne Kunden legst du unten fest, und jede Person kann unter „Mein Konto“ einen eigenen Schlüssel hinterlegen.'],
 'assistantSettings.customers.text':['Questions about a customer\'s devices use the customer\'s own key when you set one here. The customer\'s provider account pays for these questions.','Fragen zu den Geräten eines Kunden nutzen dessen eigenen Schlüssel, wenn du hier einen festlegst. Die Kosten trägt das Anbieterkonto des Kunden.'],
 'assistantSettings.personal.removeText':['After that, the assistant answers your questions with the keys an Owner added in Settings.','Danach beantwortet der Assistent deine Fragen mit den Schlüsseln, die ein Owner in den Einstellungen hinterlegt hat.'],
 'assistantSettings.organization.removeText':['After that, people can ask the assistant only with a personal key, or about devices of a customer that has its own key.','Danach können Personen den Assistenten nur noch mit einem persönlichen Schlüssel fragen oder zu Geräten eines Kunden, der einen eigenen Schlüssel hat.'],
 'sessionSettings.cardText':['These rules apply to every account in this portal.','Diese Regeln gelten für jedes Konto in diesem Portal.'],
 'sessionSettings.signOutHint':['Nodiverna signs an account out after this much time without input. A shorter time also applies to accounts that are signed in now.','Nodiverna meldet ein Konto nach dieser Zeit ohne Eingabe ab. Eine kürzere Zeit gilt auch für Konten, die gerade angemeldet sind.'],
 'nav.settings.accountsHint':['Invite people to Nodiverna and manage their accounts. Roles decide what each account can do.','Lade Personen zu Nodiverna ein und verwalte ihre Konten. Rollen legen fest, was ein Konto tun darf.'],
 'nav.settings.userGroupsHint':['Put accounts into a group to give them the same roles together.','Fasse Konten in einer Gruppe zusammen, um ihnen gemeinsam dieselben Rollen zu geben.'],
 'nav.settings.rolesHint':['A role is a set of permissions. Assign roles to accounts and user groups to decide what they can see and change.','Eine Rolle ist eine Sammlung von Berechtigungen. Weise Rollen Konten und Benutzergruppen zu, um festzulegen, was sie sehen und ändern dürfen.'],
 'nav.settings.entraHint':['Let people sign in with their Microsoft work account and get their roles from Entra groups.','Lass Personen sich mit ihrem Microsoft-Arbeitskonto anmelden und ihre Rollen aus Entra-Gruppen erhalten.'],
 'nav.settings.sessionsHint':['Choose when Nodiverna signs out inactive accounts and when it asks for MFA again.','Lege fest, wann Nodiverna inaktive Konten abmeldet und wann es erneut nach MFA fragt.'],
 'nav.settings.customersHint':['Create the customers whose devices you manage, with their contacts, data retention and maintenance windows.','Erstelle die Kunden, deren Geräte du verwaltest, mit Kontakten, Datenaufbewahrung und Wartungsfenstern.'],
 'nav.settings.notificationChannelsHint':['Send alarms by email, Microsoft Teams, Discord or webhook. Notification rules decide which alarms go to which channel.','Sende Alarme per E-Mail, Microsoft Teams, Discord oder Webhook. Benachrichtigungsregeln legen fest, welche Alarme an welchen Kanal gehen.'],
 'nav.settings.vulnerabilitiesHint':['Find installed software with known vulnerabilities on your devices.','Finde installierte Software mit bekannten Schwachstellen auf deinen Geräten.'],
 'nav.settings.assistantHint':['Add the API keys that the AI assistant uses to answer questions about devices.','Hinterlege die API-Schlüssel, mit denen der KI-Assistent Fragen zu Geräten beantwortet.'],
 'nav.settings.agentReleasesHint':['Manage the agent versions your devices can update to. You start updates in the device views.','Verwalte die Agent-Versionen, auf die deine Geräte aktualisieren können. Updates startest du in der Geräteansicht.'],
 'nav.settings.extensionsHint':['Roll out new extension versions to your devices, starting with a few pilot devices.','Verteile neue Versionen der Erweiterungen auf deine Geräte, zuerst auf wenige Pilotgeräte.'],
 'nav.settings.agentTroubleshootingHint':['Find out why a device does not show up in Nodiverna, or uninstall the agent from a device.','Finde heraus, warum ein Gerät nicht in Nodiverna erscheint, oder deinstalliere den Agent auf einem Gerät.'],
 'nav.settings.retentionHint':['Choose how long Nodiverna keeps data and when the daily cleanup runs.','Lege fest, wie lange Nodiverna Daten aufbewahrt und wann die tägliche Bereinigung läuft.'],
 'nav.settings.auditHint':['See who signed in and what changed in the portal.','Sieh, wer sich angemeldet hat und was im Portal geändert wurde.'],
 'nav.settings.usageDataHint':['Choose whether Nodiverna sends a few technical values once a day to help improve the product.','Lege fest, ob Nodiverna einmal am Tag einige technische Werte sendet, um das Produkt zu verbessern.'],
};
for(const [key,[english,german]] of Object.entries(copy))check([en[key],de[key]],[english,german],`the exact copy of ${key}`);

// The exact copy of slice 2 (device and fleet), in both languages.
const deviceCopy={
 'groups.move.description':['A device can be in only one group. After the move, the devices get the permissions, tags, alert rules and notification rules of the target group.','Ein Gerät kann nur in einer Gruppe sein. Nach dem Verschieben erhalten die Geräte die Berechtigungen, Tags, Alarmregeln und Benachrichtigungsregeln der Zielgruppe.'],
 'groups.deleteHint':['The devices stay in Nodiverna and move to Ungrouped. Roles assigned on this group are removed.','Die Geräte bleiben in Nodiverna und wechseln zu „Ohne Gruppe“. Rollen, die auf dieser Gruppe zugewiesen sind, werden entfernt.'],
 'tags.meta':['Label devices with name–value pairs to filter and find them. A tag on a group applies to all its devices, and a device or subgroup can set its own value for the same name.','Versieh Geräte mit Name-Wert-Paaren, um sie zu filtern und zu finden. Ein Tag an einer Gruppe gilt für alle ihre Geräte, und ein Gerät oder eine Untergruppe kann für denselben Namen einen eigenen Wert festlegen.'],
 'software.meta':['Programs installed on the devices, as Windows lists them under Installed apps.','Programme, die auf den Geräten installiert sind, wie Windows sie unter „Installierte Apps“ auflistet.'],
 'updates.subtitle':['Search for Windows updates and choose which ones to install.','Suche nach Windows-Updates und wähle aus, welche installiert werden.'],
 'assistant.notSetUp.owner':['To ask questions about this device, add an API key from Claude or OpenAI in Settings or in My account.','Um Fragen zu diesem Gerät zu stellen, hinterlege einen API-Schlüssel von Claude oder OpenAI in den Einstellungen oder unter „Mein Konto“.'],
 'assistant.notSetUp.member':['To ask questions about this device, add your own API key from Claude or OpenAI in My account, or ask an Owner to add a key in Settings.','Um Fragen zu diesem Gerät zu stellen, hinterlege unter „Mein Konto“ deinen eigenen API-Schlüssel von Claude oder OpenAI, oder lass einen Owner in den Einstellungen einen Schlüssel hinterlegen.'],
 'assistant.empty.text':['Ask about problems, updates or performance. The assistant answers from the data Nodiverna collects from this device and can suggest commands.','Frag nach Problemen, Updates oder Leistung. Der Assistent antwortet mit den Daten, die Nodiverna von diesem Gerät sammelt, und kann Befehle vorschlagen.'],
 'assistant.readOnlyNote':['Nothing runs on the device until you select Run on device. Check important answers before you act on them.','Auf dem Gerät läuft nichts, bevor du „Auf Gerät ausführen“ auswählst. Prüfe wichtige Antworten, bevor du danach handelst.'],
};
for(const [key,[english,german]] of Object.entries(deviceCopy))check([en[key],de[key]],[english,german],`the exact copy of ${key}`);
ok(!/apply at once/i.test(en['groups.move.description'])&&!/gelten sofort/i.test(de['groups.move.description']),'the Move drawer text no longer says "apply at once"');
ok(en['assistant.readOnlyNote'].includes(en['assistant.proposal.run'])&&de['assistant.readOnlyNote'].includes(`„${de['assistant.proposal.run']}“`),'the assistant note names the run button with its current label');
for(const key of ['assistant.empty.text','assistant.readOnlyNote'])ok(!/the portal has/i.test(en[key])&&!/(?:das|die) das Portal hat/.test(de[key]),`${key} no longer says "the portal has"`);
for(const key of ['account.preferences.description','releases.hint'])check([key in en,key in de],[false,false],`${key} is gone from both catalogs`);
ok(!/priority|organization key/i.test(en['assistantSettings.personal.text'])&&!/Vorrang/.test(de['assistantSettings.personal.text']),'the personal key intro says nothing about key order');
for(const key of ['assistantSettings.personal.removeText','assistantSettings.organization.removeText','assistantSettings.customers.removeText'])ok(!/then use|if there is one/i.test(en[key]),`${key} states the effect without "then use" or "if there is one"`);

// The exact copy of the extensions and server messages slice: the extension intros, the automation status texts and
// the Entra MFA error, in both languages.
const extensionCopy={
 'extensions.fleet.meta':['Extensions let you see and change server roles such as DHCP and DNS in Nodiverna. To install one, open a device and go to its Extensions area. This list shows the roles and software found on your devices and the extensions they run. An Owner rolls out new extension versions in Settings.','Mit Erweiterungen siehst und änderst du Serverrollen wie DHCP und DNS in Nodiverna. Um eine Erweiterung zu installieren, öffne ein Gerät und wechsle in seinen Bereich Erweiterungen. Diese Liste zeigt die Rollen und Software auf deinen Geräten und die Erweiterungen, die dort laufen. Ein Owner verteilt neue Versionen der Erweiterungen in den Einstellungen.'],
 'pluginAd.account.description':['Changes you make to a server through an extension, such as DHCP or DNS, run with your AD account. If you are not signed in for that server yet, Nodiverna asks you to sign in. Here you see your current sign-ins and can end them. Each sign-in ends when you sign out of Nodiverna, or after 8 hours at the latest.','Änderungen, die du über eine Erweiterung wie DHCP oder DNS an einem Server machst, laufen mit deinem AD-Konto. Wenn du für diesen Server noch nicht angemeldet bist, fragt Nodiverna nach deiner Anmeldung. Hier siehst du deine aktuellen Anmeldungen und kannst sie beenden. Jede Anmeldung endet, wenn du dich bei Nodiverna abmeldest, spätestens nach 8 Stunden.'],
 'dhcp.fleet.meta':['The DHCP extension updates these values every 15 minutes.','Die DHCP-Erweiterung aktualisiert diese Werte alle 15 Minuten.'],
 'dns.fleet.meta':['This list shows the zones of every DNS server that runs the DNS extension.','Diese Liste zeigt die Zonen aller DNS-Server, auf denen die DNS-Erweiterung läuft.'],
 'serverMessage.automation.localPolicy':['This device has its own drift policy. This automation assignment does not change it.','Dieses Gerät hat eine eigene Drift-Richtlinie. Diese Automationszuweisung ändert sie nicht.'],
 'serverMessage.automation.localConfiguration':['This device has its own Desired State assignment. This automation assignment does not change it.','Dieses Gerät hat eine eigene Zuweisung einer Sollkonfiguration. Diese Automationszuweisung ändert sie nicht.'],
 'entra.error.mfaMissing':['Your Microsoft sign-in did not use multifactor authentication (MFA). Ask your Entra administrator to require MFA for your account, for example by setting per-user MFA to Enforced. After that, try again.','Deine Microsoft-Anmeldung hat keine Multi-Faktor-Authentifizierung (MFA) verwendet. Lass deinen Entra-Administrator MFA für dein Konto verlangen, zum Beispiel mit MFA pro Benutzer auf „Erzwungen“. Versuche es danach erneut.'],
};
extensionCopy['apiError.entra.confirm.mfaMissing']=extensionCopy['entra.error.mfaMissing'];
for(const [key,[english,german]] of Object.entries(extensionCopy))check([en[key],de[key]],[english,german],`the exact copy of ${key}`);
for(const key of ['extensions.device.installedMeta','extensions.device.detectedMeta','extensions.blocked.demo'])check([key in en,key in de],[false,false],`${key} is gone from both catalogs`);
const entraKeys=Object.keys(en).filter(key=>key.startsWith('entra.error.')||key.startsWith('apiError.entra.confirm.'));
ok(entraKeys.length>=20,'the scan finds the Entra sign-in and confirmation errors');
for(const key of entraKeys)ok(!/then try again/i.test(en[key])&&!/Versuche es dann erneut/.test(de[key]),`${key} names the next step without "then try again"`);

// The exact copy of slice 3 (automation, monitoring, audit, agent results and help), in both languages.
const sliceThree={
 'automation.inheritanceHint':['An assignment on a group also applies to its subgroups and their devices. An assignment on a lower group or directly on a device replaces it there. If two groups at the same level give a device different templates, Nodiverna uses neither template on that device and shows “Conflict”.','Eine Zuweisung an eine Gruppe gilt auch für ihre Untergruppen und deren Geräte. Eine Zuweisung an eine tiefere Gruppe oder direkt an einem Gerät ersetzt sie dort. Geben zwei Gruppen auf derselben Ebene einem Gerät verschiedene Vorlagen, verwendet Nodiverna keine der beiden Vorlagen auf diesem Gerät und zeigt „Konflikt“.'],
 'automation.assignHint':['If you assign a template to a group, it also applies to devices and subgroups that you add later. An assignment made directly on a device replaces the group\'s assignment on that device.','Weist du eine Vorlage einer Gruppe zu, gilt sie auch für Geräte und Untergruppen, die du später hinzufügst. Eine Zuweisung direkt an einem Gerät ersetzt auf diesem Gerät die Zuweisung der Gruppe.'],
 'help.security.tip2':['A shorter time also applies to accounts that are signed in now.','Eine kürzere Zeit gilt auch für Konten, die gerade angemeldet sind.'],
 'help.assistant.tip2':['The line below the question field shows which API key answers your question. An Owner adds keys for the portal and for customers in Settings › AI assistant, and you can add your own key in My account.','Die Zeile unter dem Fragefeld zeigt, welcher API-Schlüssel deine Frage beantwortet. Ein Owner hinterlegt Schlüssel für das Portal und für Kunden unter Einstellungen › KI-Assistent, und deinen eigenen Schlüssel kannst du unter „Mein Konto“ hinterlegen.'],
 'alertRules.meta':['Alert rules decide when a device shows an issue. A value that you change here applies to this level and everything below it, unless a lower level has its own value.','Alarmregeln legen fest, wann ein Gerät einen Hinweis zeigt. Ein Wert, den du hier änderst, gilt für diese Ebene und alles darunter, sofern keine tiefere Ebene einen eigenen Wert hat.'],
 'runbooks.catchUpHint':['If a device is offline at the scheduled time, the run starts as soon as the device is back online, but only within this time. Otherwise Nodiverna skips the run.','Ist ein Gerät zum geplanten Zeitpunkt offline, startet der Lauf, sobald das Gerät wieder online ist, aber nur innerhalb dieser Zeit. Sonst überspringt Nodiverna den Lauf.'],
 'runbooks.outputHidden':['The output is hidden. To see it, you need the permission “Read the output of your own PowerShell runbooks”.','Die Ausgabe ist ausgeblendet. Um sie zu sehen, brauchst du die Berechtigung „Ausgaben eigener PowerShell-Runbooks lesen“.'],
};
for(const [key,[english,german]] of Object.entries(sliceThree))check([en[key],de[key]],[english,german],`the exact copy of ${key}`);
// The output notice names the permission by its label, never by its id.
check([en['runbooks.outputHidden'].includes(`“${en['permission.runbooks.outputs']}”`),de['runbooks.outputHidden'].includes(`„${de['permission.runbooks.outputs']}“`)],[true,true],'the hidden output notice names the permission label');
ok(!/runbooks\.outputs/.test(en['runbooks.outputHidden']+de['runbooks.outputHidden']),'the hidden output notice names no permission id');
check(['alarms.loading' in en,'alarms.loading' in de],[false,false],'alarms.loading, which no code read, is gone from both catalogs');


// A permission named in quotes in device and fleet copy is the exact label of a permission (permission.*), so the user
// finds it in the role editor. "{right}" is a placeholder that the code fills with such a label.
const deviceKeys=/^(fleet|devices|tree|groups|tags|csv|addDevice|software|drivers|certificates|autostart|osSupport|encryption|bitlocker|protection|reliability|crashes|vulnerabilities|device|deviceType|agentMode|agentIntegrity|health|hardware|diskHealth|battery|monitoring|diagnostics|services|updates|storage|network|accounts|roles|operation|defender|files|rdp|terminal|drift|desired|assistant)\./;
const quotedPermissions=(text,language)=>{
 const [list,name]=language==='en'?[/\bpermissions? ((?:“[^”]+”(?:,? (?:and|or) |, )?)+)/g,/“([^”]+)”/g]:[/\bBerechtigung(?:en)? ((?:„[^“]+“(?:,? (?:und|oder) |, )?)+)/g,/„([^“]+)“/g];
 return [...text.matchAll(list)].flatMap(match=>[...match[1].matchAll(name)].map(found=>found[1])).filter(found=>!/^\{\w+\}$/.test(found));
};
check(quotedPermissions('You need the permission “View devices” and “Run diagnostics”.','en'),['View devices','Run diagnostics'],'the permission check reads every quoted name');
for(const [language,catalog] of catalogs){
 const labels=new Set(Object.keys(catalog).filter(key=>key.startsWith('permission.')).map(key=>catalog[key]));
 const named=Object.entries(catalog).filter(([key])=>deviceKeys.test(key)&&!/Keywords$/.test(key)).flatMap(([key,message])=>values(message).flatMap(text=>quotedPermissions(text,language).map(found=>[key,found])));
 ok(named.length>=20,`the ${language} device copy names permissions in quotes`);
 check(named.filter(([,found])=>!labels.has(found)),[],`every quoted permission in the ${language} device copy is a permission label`);
}

// The exact copy of the DHCP and DNS extension result messages (agentMessage.PLUGIN_*), in both languages. The plugins
// send the same English text with "plugin" for "extension" (tests/agent/agent-messages.mjs checks that).
const pluginCopy={
 'agentMessage.PLUGIN_DHCP_READ_COMPLETED':['The DHCP server was read. Scopes: {scopes}, leases: {leases}.','Der DHCP-Server wurde gelesen. Bereiche: {scopes}, Leases: {leases}.'],
 'agentMessage.PLUGIN_DHCP_SERVICE_STOPPED':['The DHCP Server service is stopped. Start the service in Management → Services.','Der Dienst DHCP-Server ist gestoppt. Starte den Dienst unter Verwaltung → Dienste.'],
 'agentMessage.PLUGIN_DHCP_ACCESS_DENIED':['The DHCP server refused access to the DHCP extension. On the server, check the members of the groups DHCP Administrators and DHCP Users.','Der DHCP-Server hat der DHCP-Erweiterung den Zugriff verweigert. Prüfe auf dem Server die Mitglieder der Gruppen „DHCP-Administratoren“ und „DHCP-Benutzer“.'],
 'agentMessage.PLUGIN_DHCP_NOT_INSTALLED':['The DHCP Server role is not installed on this device. Install the role in Management → Roles & features, or remove the DHCP extension in the Extensions area.','Die Rolle DHCP-Server ist auf diesem Gerät nicht installiert. Installiere die Rolle unter Verwaltung → Rollen & Features oder entferne die DHCP-Erweiterung im Bereich Erweiterungen.'],
 'agentMessage.PLUGIN_DHCP_CHANGED_NOT_READ':['The DHCP server was changed, but the extension could not read it afterwards. Select “Read again” to see the change.','Der DHCP-Server wurde geändert, aber die Erweiterung konnte ihn danach nicht lesen. Wähle „Erneut lesen“, um die Änderung zu sehen.'],
 'agentMessage.PLUGIN_DHCP_INVALID_CHANGE':['The DHCP extension did not make the change because the value of {field} is not valid. Correct the value and try again.','Die DHCP-Erweiterung hat die Änderung nicht ausgeführt, weil der Wert von {field} ungültig ist. Korrigiere den Wert und versuche es erneut.'],
 'agentMessage.PLUGIN_DHCP_OBJECT_EXISTS':['{object} already exists on the DHCP server. Select “Read again” to see the current state.','{object} existiert schon auf dem DHCP-Server. Wähle „Erneut lesen“, um den aktuellen Stand zu sehen.'],
 'agentMessage.PLUGIN_DHCP_OBJECT_MISSING':['{object} does not exist on the DHCP server. Select “Read again” to see the current state.','{object} existiert nicht auf dem DHCP-Server. Wähle „Erneut lesen“, um den aktuellen Stand zu sehen.'],
 'agentMessage.PLUGIN_DHCP_IN_FAILOVER':['Scope {scope} is part of a failover relationship. Remove the scope from the relationship on the Failover tab, and try again.','Der Bereich {scope} gehört zu einer Failover-Beziehung. Nimm den Bereich auf dem Tab Failover aus der Beziehung und versuche es erneut.'],
 'agentMessage.PLUGIN_DHCP_SECRET_MISSING':['The shared secret did not reach the DHCP extension. Update the agent on this device to 4.17.0 or later, and try again.','Das gemeinsame Geheimnis hat die DHCP-Erweiterung nicht erreicht. Aktualisiere den Agent auf diesem Gerät auf 4.17.0 oder neuer und versuche es erneut.'],
 'agentMessage.PLUGIN_DNS_READ_COMPLETED':['The DNS server was read. Zones: {zones}.','Der DNS-Server wurde gelesen. Zonen: {zones}.'],
 'agentMessage.PLUGIN_DNS_ZONE_READ_COMPLETED':['Zone {zone} was read. Records: {records}.','Die Zone {zone} wurde gelesen. Einträge: {records}.'],
 'agentMessage.PLUGIN_DNS_SERVICE_STOPPED':['The DNS Server service is stopped. Start the service in Management → Services.','Der Dienst DNS-Server ist gestoppt. Starte den Dienst unter Verwaltung → Dienste.'],
 'agentMessage.PLUGIN_DNS_NOT_INSTALLED':['The DNS Server role is not installed on this device. Install the role in Management → Roles & features, or remove the DNS extension in the Extensions area.','Die Rolle DNS-Server ist auf diesem Gerät nicht installiert. Installiere die Rolle unter Verwaltung → Rollen & Features oder entferne die DNS-Erweiterung im Bereich Erweiterungen.'],
 'agentMessage.PLUGIN_DNS_ACCESS_DENIED':['The DNS server refused access to the DNS extension. On the server, check the members of the group DnsAdmins.','Der DNS-Server hat der DNS-Erweiterung den Zugriff verweigert. Prüfe auf dem Server die Mitglieder der Gruppe DnsAdmins.'],
 'agentMessage.PLUGIN_DNS_CHANGED_NOT_READ':['The DNS server was changed, but the extension could not read it afterwards. Select “Read again” to see the change.','Der DNS-Server wurde geändert, aber die Erweiterung konnte ihn danach nicht lesen. Wähle „Erneut lesen“, um die Änderung zu sehen.'],
 'agentMessage.PLUGIN_DNS_INVALID_CHANGE':['The DNS extension did not make the change because the value of {field} is not valid. Correct the value and try again.','Die DNS-Erweiterung hat die Änderung nicht ausgeführt, weil der Wert von {field} ungültig ist. Korrigiere den Wert und versuche es erneut.'],
 'agentMessage.PLUGIN_DNS_OBJECT_EXISTS':['{object} already exists on the DNS server. Select “Read again” to see the current state.','{object} existiert schon auf dem DNS-Server. Wähle „Erneut lesen“, um den aktuellen Stand zu sehen.'],
 'agentMessage.PLUGIN_DNS_OBJECT_MISSING':['{object} does not exist on the DNS server. Select “Read again” to see the current state.','{object} existiert nicht auf dem DNS-Server. Wähle „Erneut lesen“, um den aktuellen Stand zu sehen.'],
 'agentMessage.PLUGIN_DNS_NOT_DOMAIN_CONTROLLER':['This server is not a domain controller, so it cannot store zones in Active Directory. Store the zone in a file on this server instead.','Dieser Server ist kein Domänencontroller und kann deshalb keine Zonen in Active Directory speichern. Speichere die Zone stattdessen in einer Datei auf diesem Server.'],
};
check(Object.keys(pluginCopy).length,20,'the 20 rewritten extension result messages');
for(const [key,[english,german]] of Object.entries(pluginCopy))check([en[key],de[key]],[english,german],`the exact copy of ${key}`);
// The result message and the blocked reason of the portal say the same about a stopped service.
for(const [plugin,portal] of [['agentMessage.PLUGIN_DHCP_SERVICE_STOPPED','dhcp.blocked.stopped'],['agentMessage.PLUGIN_DNS_SERVICE_STOPPED','dns.blocked.stopped']])check([en[plugin],de[plugin]],[en[portal],de[portal]],`${plugin} equals ${portal}`);
// The failover message names the Failover tab and the same action as the portal's failover error.
ok(en['agentMessage.PLUGIN_DHCP_IN_FAILOVER'].includes(en['dhcp.tab.failover'])&&de['agentMessage.PLUGIN_DHCP_IN_FAILOVER'].includes(de['dhcp.tab.failover']),'PLUGIN_DHCP_IN_FAILOVER names the Failover tab');
for(const [catalog,action] of [[en,'Remove the scope from the relationship on the Failover tab, and try again.'],[de,'Nimm den Bereich auf dem Tab Failover aus der Beziehung und versuche es erneut.']])ok(catalog['agentMessage.PLUGIN_DHCP_IN_FAILOVER'].endsWith(action)&&catalog['dhcp.error.inFailover'].endsWith(action),`PLUGIN_DHCP_IN_FAILOVER and dhcp.error.inFailover end with the same action: ${action}`);
// No extension result message counts with "{n} noun" or says "is no".
const pluginEnglish=Object.entries(en).filter(([key])=>/^agentMessage\.PLUGIN_/.test(key));
ok(pluginEnglish.length>=27,'the scan sees the extension result messages');
check(pluginEnglish.filter(([,message])=>values(message).some(text=>/\{(scopes|leases|zones|records)\} (scopes|leases|zones|records)\b/.test(text)||/\bis no \w/.test(text))).map(([key])=>key),[],'no extension result message says "{n} scopes" or "is no"');

console.log(`PASS copy plain language (${checks} checks): forbidden phrases in the four catalogs, the pending list, the self-check samples, the exact copy of slices 1 to 4 and of the extension result messages, the removed keys and the quoted permission names of the device copy.`);
