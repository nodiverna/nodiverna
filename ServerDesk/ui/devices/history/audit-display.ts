// How the console shows a stored audit row (the audit log page and the device
// access views, ui/devices/history/activity-table.tsx). The audit table keeps every
// action as it was written: a code (tag.set, auth.entra.confirm.refused), a
// German text of log() or an inline writer, an English text of a writer
// constant, or the German label of an operation or diagnostic job. This module
// maps each of them to one stable code with a catalog label
// (audit.action.<code>, both languages), or to job.<kind> with the job's own
// label, so the visible label never depends on the language the writer used.
// It imports the writer constants (lib/audit-actions.ts, runtime/audit-actions.mjs),
// so a changed constant cannot drift from the map; tests/ui/devices/audit-display.mjs scans
// the writers for every literal. Pure: the client imports it.
import {translate,type MessageKey} from '@/lib/i18n/translate';
import {defaultLocale,type Locale} from '@/lib/i18n/locale';
import {EMPTY_VALUE,formatDuration} from '@/lib/i18n/format';
import {isInternalAccountValue} from '@/lib/account-display';
import {cell,quote} from '@/ui/devices/fleet/fleet-csv';
import {operations} from '@/lib/management';
import {diagnosticDefinitions} from '@/lib/diagnostics';
import {pluginJobLabelKey} from '@/lib/job-display';
import {DHCP_CHANGE_OPERATIONS,DNS_CHANGE_OPERATIONS,PLUGIN_JOB} from '@/lib/plugin-catalog';
import {assistantPowerShellKind} from '@/lib/assistant-config';
import {
 adAuditActions,dhcpCrossCustomerAuditAction,dhcpReplicateAuditAction,maintenanceAuditAction,pluginAuditActions,releaseSourceAuditActions,retiredReleaseSourceAuditActions,roleSyncAuditAction,
 routeAuditActions,sessionIdleRequiresMfaAuditAction,sessionIdleTimeoutAuditAction,usageDataAuditActions,vulnerabilityAuditActions,
} from '@/lib/audit-actions';
import {auditRetentionAuditAction,maintenanceRunAuditAction,pluginImportAuditActions,releaseImportAuditActions,secretsRewrapAuditAction,totpResetAuditAction} from '@/runtime/audit-actions.mjs';
import type {AuditEntry} from '@/lib/types';
import {jobActionLabel} from '@/ui/shell/console-jobs';

/** The "Action type" filter of the activity table. */
export type ActivityCategory='signIn'|'accounts'|'devices'|'jobs'|'settings'|'other';
export const activityCategories:readonly ActivityCategory[]=['signIn','accounts','devices','jobs','settings','other'];

/**
 * The known codes and their category: sign-in, MFA, passkeys, lockout and emergency access → signIn; accounts, user
 * groups, roles, assignments, technicians, customers and installers → accounts; device name, description, tags, ESU,
 * groups, agent integrity, agent update, uninstall and removal → devices; terminal, RDP, files, transfers, runbooks,
 * desired state, drift, Defender, plugins, AD sign-in and the assistant → jobs (operation jobs are job.<kind>);
 * Entra settings, sessions, notification channels, retention or maintenance, assistant settings, alert rules and
 * releases → settings; the rest → other. Each has audit.action.<code> in both catalogs.
 */
export const auditActionCodes={
 'auth.login':'signIn',
 'auth.lockout':'signIn',
 'auth.entra.login':'signIn',
 'auth.entra.login.refused':'signIn',
 'auth.entra.confirm':'signIn',
 'auth.entra.confirm.refused':'signIn',
 'auth.emergency.login':'signIn',
 'auth.emergency.acknowledge':'signIn',
 'auth.entra.emergency.set':'signIn',
 'mfa.setup':'signIn',
 'mfa.signIn':'signIn',
 'mfa.authenticator.set':'signIn',
 'mfa.authenticator.rename':'signIn',
 'mfa.authenticator.remove':'signIn',
 'mfa.disable':'signIn',
 'mfa.recoveryCodes.renew':'signIn',
 'mfa.totp.resetAll':'signIn',
 'passkey.add':'signIn',
 'passkey.mfaSetup':'signIn',
 'passkey.signIn':'signIn',
 'passkey.rename':'signIn',
 'passkey.remove':'signIn',
 'auth.owner.bootstrap':'accounts',
 'auth.invitation.redeem':'accounts',
 'auth.password.reset':'accounts',
 'auth.password.change':'accounts',
 'auth.user.create':'accounts',
 'auth.user.update':'accounts',
 'auth.user.enable':'accounts',
 'auth.user.disable':'accounts',
 'auth.user.password-link':'accounts',
 'auth.entra.account.create':'accounts',
 'auth.entra.check.groups':'accounts',
 'auth.entra.check.locked':'accounts',
 'auth.entra.check.restored':'accounts',
 'auth.entra.check.failed':'accounts',
 'auth.entra.roles.sync':'accounts',
 'auth.entra.mapping.add':'accounts',
 'auth.entra.mapping.remove':'accounts',
 'userGroup.create':'accounts',
 'userGroup.update':'accounts',
 'userGroup.delete':'accounts',
 'userGroup.member.add':'accounts',
 'userGroup.member.remove':'accounts',
 'role.create':'accounts',
 'role.update':'accounts',
 'role.delete':'accounts',
 'roleAssignment.create':'accounts',
 'roleAssignment.remove':'accounts',
 'accountLinks.expire.customer':'accounts',
 'accountLinks.expire.rights':'accounts',
 'deviceGroup.rights.set':'accounts',
 'deviceGroup.share.remove':'accounts',
 'customer.create':'settings',
 'customer.update':'settings',
 'customer.deactivate':'settings',
 'customer.activate':'settings',
 // Deleting a customer (customerAuditActions in lib/audit-actions.ts) stores this code.
 'customer.delete':'settings',
 // The setting "Multiple customers" (multipleCustomersAuditActions in lib/audit-actions.ts) stores these codes.
 'customers.multiple.enable':'settings',
 'customers.multiple.disable':'settings',
 // The branding images (brandingAuditActions in lib/audit-actions.ts) store these codes; the target is the slot.
 'branding.portal.set':'settings',
 'branding.portal.remove':'settings',
 'branding.customer.set':'settings',
 'branding.customer.remove':'settings',
 // The background choices and the brand color scheme of the same page; the target is the area or "scheme".
 'branding.background.set':'settings',
 'branding.scheme.set':'settings',
 'branding.scheme.remove':'settings',
 // The Owner's default Dashboard layout (dashboardAuditActions in lib/audit-actions.ts); the target is "layout".
 'dashboard.default.set':'settings',
 'dashboard.default.remove':'settings',
 'technician.update':'accounts',
 'installer.create':'accounts',
 'installer.revoke':'accounts',
 'agent.create':'devices',
 'agent.installer.register':'devices',
 'agent.update.schedule':'devices',
 'agent.update.crossCustomer':'devices',
 'agent.uninstall.request':'devices',
 'agent.uninstall.start':'devices',
 'agent.uninstall.fail':'devices',
 'device.remove':'devices',
 // Moving devices to another customer (deviceCustomerAuditActions in lib/audit-actions.ts) stores this code.
 'device.customer.move':'devices',
 'device.name.set':'devices',
 'device.name.hostname':'devices',
 'device.description.set':'devices',
 'device.groups.set':'devices',
 'deviceGroup.create':'devices',
 'deviceGroup.update':'devices',
 'deviceGroup.delete':'devices',
 'tag.set':'devices',
 'tag.remove':'devices',
 'os-esu.set':'devices',
 'os-esu.clear':'devices',
 'autostart.confirm':'devices',
 'agent.integrity.service-stopped':'devices',
 'agent.integrity.service-ended':'devices',
 'agent.integrity.service-hung':'devices',
 'agent.integrity.service-restarted':'devices',
 'agent.integrity.broker-unresponsive':'devices',
 'agent.integrity.start-type-changed':'devices',
 'agent.integrity.agent-removed':'devices',
 'agent.integrity.protection-changed':'devices',
 'jobs.cancel':'jobs',
 'terminal.open':'jobs',
 'terminal.close':'jobs',
 'terminal.closeOther':'jobs',
 'rdp.open':'jobs',
 'rdp.close':'jobs',
 'transfer.upload':'jobs',
 'transfer.download':'jobs',
 'transfer.cancel':'jobs',
 'runbook.start':'jobs',
 'runbook.crossCustomer':'jobs',
 'runbook.cancel':'jobs',
 'runbook.delete':'jobs',
 'runbook.version.create':'jobs',
 'runbook.assignment.start':'jobs',
 'runbook.assignment.schedule':'jobs',
 'runbook.schedule.approve':'jobs',
 'runbook.schedule.disable':'jobs',
 'runbook.schedule.start':'jobs',
 'runbook.schedule.skip':'jobs',
 'runbook.schedule.crossCustomerOff':'jobs',
 'runbook.schedule.rightsOff':'jobs',
 'automation.assign':'jobs',
 'automation.inherited.suspend':'jobs',
 'automation.assignment.remove':'jobs',
 'automation.template.create':'jobs',
 'desired.apply':'jobs',
 'desired.test':'jobs',
 'desired.crossCustomer':'jobs',
 'desired.config.delete':'jobs',
 'desired.interval.set':'jobs',
 'desired.schedule.rightsOff':'jobs',
 'desired.version.save':'jobs',
 'desired.version.assign':'jobs',
 'desired.assignment.remove':'jobs',
 'drift.baseline.approve':'jobs',
 'drift.enable':'jobs',
 'drift.pause':'jobs',
 'drift.policy.set':'jobs',
 'drift.policy.applyMembers':'jobs',
 'defender.crossCustomer':'jobs',
 'plugin.install.queued':'jobs',
 'plugin.remove.queued':'jobs',
 'plugin.rollout.planned':'jobs',
 'plugin.rollout.crossCustomer':'jobs',
 'dhcp.crossCustomer':'jobs',
 'dhcp.failover.replicate':'jobs',
 'plugin.ad.signIn':'jobs',
 'plugin.ad.signInFailed':'jobs',
 'plugin.ad.signOut':'jobs',
 'assistant.ask':'jobs',
 'assistant.run':'jobs',
 'auth.entra.settings.update':'settings',
 'auth.entra.settings.test':'settings',
 'auth.entra.enable':'settings',
 'auth.entra.disable':'settings',
 'auth.entra.only.on':'settings',
 'auth.entra.only.off':'settings',
 'session.idleTimeout.set':'settings',
 'session.idleMfa.set':'settings',
 'notification-channel.create':'settings',
 'notification-channel.update':'settings',
 'notification-channel.delete':'settings',
 'notification-channel.enable':'settings',
 'notification-channel.disable':'settings',
 'notification-channel.rotate-secret':'settings',
 'notification-channel.test':'settings',
 'notification-rule.create':'settings',
 'notification-rule.update':'settings',
 'notification-rule.delete':'settings',
 'alert-rule.set':'settings',
 'alert-rule.reset':'settings',
 'maintenance.settings.set':'settings',
 'maintenance.run.start':'settings',
 'retention.audit.apply':'settings',
 'assistant.organization-key.set':'settings',
 'assistant.organization-key.removed':'settings',
 'assistant.personal-key.set':'settings',
 'assistant.personal-key.removed':'settings',
 'assistant.customer-key.set':'settings',
 'assistant.customer-key.removed':'settings',
 'release.import':'settings',
 'release.delete':'settings',
 'release.disable':'settings',
 'release.check':'settings',
 'release.devBuildsOn':'settings',
 'release.devBuildsOff':'settings',
 'release.token.set':'settings',
 'release.token.remove':'settings',
 'release.import.github':'settings',
 'release.import.folder':'settings',
 'plugin.release.import.github':'settings',
 'plugin.release.import.folder':'settings',
 'vulnerability.on':'settings',
 'vulnerability.off':'settings',
 'vulnerability.nvdKey.set':'settings',
 'vulnerability.nvdKey.remove':'settings',
 'vulnerability.cveOrg.on':'settings',
 'vulnerability.cveOrg.off':'settings',
 'usageData.enable':'settings',
 'usageData.disable':'settings',
 'secrets.rewrap':'settings',
 'alert.acknowledge':'other',
 'alert.mute':'other',
 'alert.unmute':'other',
} as const satisfies Record<string,ActivityCategory>;
export type AuditActionCode=keyof typeof auditActionCodes;

/** Stored texts (German or English) and their code: the inline writer literals and the writer constants. */
const storedTexts:Record<string,AuditActionCode>={
 'MFA eingerichtet':'mfa.setup',
 'MFA angemeldet':'mfa.signIn',
 'Authenticator eingerichtet oder zurückgesetzt':'mfa.authenticator.set',
 'Authenticator umbenannt':'mfa.authenticator.rename',
 'Authenticator entfernt':'mfa.authenticator.remove',
 'MFA deaktiviert':'mfa.disable',
 'MFA-Wiederherstellungscodes erneuert':'mfa.recoveryCodes.renew',
 [totpResetAuditAction]:'mfa.totp.resetAll',
 'Passkey eingerichtet':'passkey.add',
 'MFA mit Passkey eingerichtet':'passkey.mfaSetup',
 'Mit Passkey angemeldet':'passkey.signIn',
 'Passkey umbenannt':'passkey.rename',
 'Passkey entfernt':'passkey.remove',
 [roleSyncAuditAction]:'auth.entra.roles.sync',
 'Benutzergruppe erstellt':'userGroup.create',
 'Benutzergruppe geändert':'userGroup.update',
 'Benutzergruppe gelöscht':'userGroup.delete',
 'Benutzergruppenmitglied hinzugefügt':'userGroup.member.add',
 'Benutzergruppenmitglied entfernt':'userGroup.member.remove',
 'Benutzerdefinierte Rolle erstellt':'role.create',
 'Benutzerdefinierte Rolle geändert':'role.update',
 'Benutzerdefinierte Rolle gelöscht':'role.delete',
 'Rollenzuweisung erstellt':'roleAssignment.create',
 'Rollenzuweisung entfernt':'roleAssignment.remove',
 'Konto-Links wegen Kundenzuweisung verfallen':'accountLinks.expire.customer',
 'Konto-Links wegen Rechteanstieg verfallen':'accountLinks.expire.rights',
 'Gerätegruppenrechte geändert':'deviceGroup.rights.set',
 'Gerätegruppenfreigabe entfernt':'deviceGroup.share.remove',
 'Kunde angelegt':'customer.create',
 'Kunde geändert':'customer.update',
 'Kunde deaktiviert':'customer.deactivate',
 'Kunde aktiviert':'customer.activate',
 'Techniker geändert':'technician.update',
 'Installer erzeugt':'installer.create',
 'Installer widerrufen':'installer.revoke',
 [routeAuditActions.agentCreated]:'agent.create',
 'Agent über Installer registriert':'agent.installer.register',
 [routeAuditActions.agentUpdateScheduled]:'agent.update.schedule',
 'Agent-Update kundenübergreifend geplant':'agent.update.crossCustomer',
 'Agent-Deinstallation angefordert':'agent.uninstall.request',
 'Agent-Deinstallation gestartet':'agent.uninstall.start',
 'Agent-Deinstallation fehlgeschlagen':'agent.uninstall.fail',
 'Gerät aus Portal entfernt':'device.remove',
 'Gerätezuordnung geändert':'device.groups.set',
 'Gerätegruppe erstellt':'deviceGroup.create',
 'Gerätegruppe geändert':'deviceGroup.update',
 'Gerätegruppe gelöscht':'deviceGroup.delete',
 [routeAuditActions.jobCancelled]:'jobs.cancel',
 'SYSTEM-Terminal geöffnet':'terminal.open',
 'Terminal geschlossen':'terminal.close',
 'Fremdes Terminal als Administrator geschlossen':'terminal.closeOther',
 [routeAuditActions.rdpOpened]:'rdp.open',
 [routeAuditActions.rdpClosed]:'rdp.close',
 'Dateiupload angelegt':'transfer.upload',
 'Dateidownload angelegt':'transfer.download',
 [routeAuditActions.transferCancelled]:'transfer.cancel',
 'Runbook gestartet':'runbook.start',
 'Runbook kundenübergreifend gestartet':'runbook.crossCustomer',
 'Runbook-Abbruch angefordert':'runbook.cancel',
 'Runbook gelöscht':'runbook.delete',
 'Runbook-Version erstellt':'runbook.version.create',
 'Runbook über Zuweisung gestartet':'runbook.assignment.start',
 'Runbook-Zuweisung per Zeitplan gestartet':'runbook.assignment.schedule',
 'Runbook-Zeitplan mit MFA freigegeben':'runbook.schedule.approve',
 'Runbook-Zeitplan deaktiviert':'runbook.schedule.disable',
 'Runbook-Zeitplan gestartet':'runbook.schedule.start',
 'Runbook-Termin außerhalb Nachholfenster übersprungen':'runbook.schedule.skip',
 'Runbook-Zeitplan über mehrere Kunden deaktiviert':'runbook.schedule.crossCustomerOff',
 'Runbook-Zeitplan wegen entzogener Rechte deaktiviert':'runbook.schedule.rightsOff',
 'Automatisierung zugewiesen':'automation.assign',
 'Geerbte Automatisierung ausgesetzt':'automation.inherited.suspend',
 'Automatisierungszuweisung entfernt':'automation.assignment.remove',
 'Automatisierungsvorlage erstellt':'automation.template.create',
 'Desired State anwenden':'desired.apply',
 'Desired State prüfen':'desired.test',
 'Desired State kundenübergreifend zugewiesen':'desired.crossCustomer',
 'Desired-State-Konfiguration gelöscht':'desired.config.delete',
 'Desired-State-Prüfintervall geändert':'desired.interval.set',
 'Desired-State-Prüfplan wegen entzogener Rechte deaktiviert':'desired.schedule.rightsOff',
 'Desired-State-Version gespeichert':'desired.version.save',
 'Desired-State-Version zugewiesen':'desired.version.assign',
 'Desired-State-Zuweisung entfernt':'desired.assignment.remove',
 'Drift-Baseline ausdrücklich freigegeben':'drift.baseline.approve',
 'Drift-Monitoring aktiviert':'drift.enable',
 'Drift-Monitoring pausiert':'drift.pause',
 'Drift-Richtlinie geändert':'drift.policy.set',
 'Drift-Richtlinie auf aktuelle Gruppenmitglieder angewandt':'drift.policy.applyMembers',
 'Defender-Aktion kundenübergreifend gestartet':'defender.crossCustomer',
 [pluginAuditActions.installQueued]:'plugin.install.queued',
 [pluginAuditActions.removalQueued]:'plugin.remove.queued',
 [pluginAuditActions.rolloutPlanned]:'plugin.rollout.planned',
 [pluginAuditActions.rolloutAcrossCustomers]:'plugin.rollout.crossCustomer',
 [dhcpCrossCustomerAuditAction]:'dhcp.crossCustomer',
 [dhcpReplicateAuditAction]:'dhcp.failover.replicate',
 [adAuditActions.signIn]:'plugin.ad.signIn',
 [adAuditActions.failed]:'plugin.ad.signInFailed',
 [adAuditActions.signOut]:'plugin.ad.signOut',
 [sessionIdleTimeoutAuditAction]:'session.idleTimeout.set',
 [sessionIdleRequiresMfaAuditAction]:'session.idleMfa.set',
 [maintenanceAuditAction]:'maintenance.settings.set',
 [maintenanceRunAuditAction]:'maintenance.run.start',
 [auditRetentionAuditAction]:'retention.audit.apply',
 [routeAuditActions.releaseImported]:'release.import',
 [routeAuditActions.releaseDeleted]:'release.delete',
 [routeAuditActions.releaseDisabled]:'release.disable',
 [releaseSourceAuditActions.checkRequested]:'release.check',
 [releaseSourceAuditActions.devBuildsOn]:'release.devBuildsOn',
 [releaseSourceAuditActions.devBuildsOff]:'release.devBuildsOff',
 [retiredReleaseSourceAuditActions.tokenSet]:'release.token.set',
 [retiredReleaseSourceAuditActions.tokenRemoved]:'release.token.remove',
 [releaseImportAuditActions.github]:'release.import.github',
 [releaseImportAuditActions.folder]:'release.import.folder',
 [pluginImportAuditActions.github]:'plugin.release.import.github',
 [pluginImportAuditActions.folder]:'plugin.release.import.folder',
 [vulnerabilityAuditActions.on]:'vulnerability.on',
 [vulnerabilityAuditActions.off]:'vulnerability.off',
 [vulnerabilityAuditActions.keySet]:'vulnerability.nvdKey.set',
 [vulnerabilityAuditActions.keyRemoved]:'vulnerability.nvdKey.remove',
 [vulnerabilityAuditActions.secondSourceOn]:'vulnerability.cveOrg.on',
 [vulnerabilityAuditActions.secondSourceOff]:'vulnerability.cveOrg.off',
 [usageDataAuditActions.enabled]:'usageData.enable',
 [usageDataAuditActions.disabled]:'usageData.disable',
 [secretsRewrapAuditAction]:'secrets.rewrap',
};

/**
 * The action of every operation and diagnostic job (lib/server/devices/device-job-queue.ts writes the kind's German label),
 * of the assistant script job (its definition label) and of every DHCP and DNS change (the English label of the
 * plugin operation, dhcpAuditAction and dnsAuditAction): the job kind and, for a plugin job, its operation.
 */
const jobActions=new Map<string,{kind:string;operation?:string}>([
 ...Object.entries(operations).map(([kind,definition])=>[definition.label,{kind}] as const),
 ...Object.entries(diagnosticDefinitions).map(([kind,definition])=>[definition.label,{kind}] as const),
 ['assistant.powershell',{kind:assistantPowerShellKind}],
 ...[...DHCP_CHANGE_OPERATIONS,...DNS_CHANGE_OPERATIONS].map(operation=>[translate('en',pluginJobLabelKey(PLUGIN_JOB,operation)!),{kind:PLUGIN_JOB,operation}] as const),
]);

/**
 * How the console shows a stored action. A known code or text: its code, the catalog key audit.action.<code> and its
 * category. A job action: code job.<kind> (job.<operation> for a plugin change), label 'job' (the caller uses
 * jobActionLabel(jobKind, locale, jobTarget)) and category jobs. An unknown value that looks like a code: that code,
 * known false, no label. Any other text: no code, the label activity.action.unlisted; the stored text appears only
 * in the details.
 */
export type AuditActionView={code:string;labelKey?:MessageKey;label?:'job';jobKind?:string;jobTarget?:string;category:ActivityCategory;known:boolean};
export const codeShape=/^[a-z][a-z0-9]*([.-][a-zA-Z0-9]+)*$/;
const own=<T,>(map:Record<string,T>,key:string)=>Object.hasOwn(map,key)?map[key]:undefined;
export function auditActionView(stored:string):AuditActionView{
 const value=String(stored??'').trim();
 const code=Object.hasOwn(auditActionCodes,value)?value as AuditActionCode:own(storedTexts,value);
 if(code)return {code,labelKey:`audit.action.${code}` as MessageKey,category:auditActionCodes[code],known:true};
 const job=jobActions.get(value);
 if(job)return {code:`job.${job.operation??job.kind}`,label:'job',jobKind:job.kind,...(job.operation?{jobTarget:job.operation}:{}),category:'jobs',known:true};
 if(codeShape.test(value))return {code:value,category:'other',known:false};
 return {code:'',labelKey:'activity.action.unlisted',category:'other',known:false};
}
/** The stored texts the map knows (for the tests). */
export const auditStoredTexts=():string[]=>[...Object.keys(storedTexts),...jobActions.keys()];

// ---- Target ----
export type AuditTargetView={text:string;mono:boolean;details:{label:string;value:string}[]};
const guidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const pairPattern=/^[A-Za-z][\w.-]*=\S*(?:\s+[A-Za-z][\w.-]*=\S*)*$/;
const jsonNameKeys=['name','displayName','account','user','customer','channel','rule','group','device','tag','model'];
const pairNameKeys=['user','account','name','object','reason'];
const textOf=(value:unknown)=>typeof value==='string'?value:JSON.stringify(value)??'';
function jsonObject(value:string):Record<string,unknown>|null{
 if(!value.startsWith('{'))return null;
 try{const parsed:unknown=JSON.parse(value);return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed as Record<string,unknown>:null;}catch{return null;}
}
/**
 * Server-written target texts that are not in the viewer's language, each read back to catalog text. The stored
 * forms come from the writers (usageDataAudit.target, releaseSourceAuditTarget, vulnerabilityAuditTarget,
 * idleTimeoutAuditTarget, idleMfaAuditTarget, automationAssignmentAuditTarget, crossCustomerAuditTarget in
 * lib/server/); tests/ui/devices/audit-display.mjs builds its fixtures with them, so a changed writer fails there.
 * A pattern applies only to the action code that writes it.
 */
const fixedTargets:Readonly<Record<string,MessageKey>>={
 'Daten zur Produktverbesserung':'usage.title',
 'Agent releases':'nav.settings.agentReleases',
 'Vulnerability check':'vulnerabilities.settings.title',
};
const brandingSlotLabels:Readonly<Record<string,MessageKey>>={light:'branding.slot.light',dark:'branding.slot.dark',icon:'branding.icon.title',signin:'branding.target.signin',console:'branding.target.console',scheme:'branding.scheme.title'};
const idleTimeoutTarget=/^(\d+) → (\d+) Minuten$/,idleMfaTarget=/^(an|aus) → (an|aus)$/,assignmentTarget=/^(.*) · (Gruppe|Gerät)$/,crossCustomerTarget=/^(.*) · (\d+) von (\d+) Geräten$/;
function translatedTarget(stored:string,action:string,locale:Locale):string|null{
 const fixed=own(fixedTargets,stored);
 if(fixed)return translate(locale,fixed);
 const code=auditActionView(action).code;
 // A branding row stores its slot: the slot label of the Branding page.
 if(code.startsWith('branding.')&&Object.hasOwn(brandingSlotLabels,stored))return translate(locale,brandingSlotLabels[stored]);
 // The default Dashboard layout stores "layout": the name of the page.
 if(code.startsWith('dashboard.default.')&&stored==='layout')return translate(locale,'rail.dashboard');
 let match=code==='session.idleTimeout.set'?idleTimeoutTarget.exec(stored):null;
 if(match)return `${formatDuration(locale,Number(match[1])*60_000)} → ${formatDuration(locale,Number(match[2])*60_000)}`;
 match=code==='session.idleMfa.set'?idleMfaTarget.exec(stored):null;
 if(match)return [match[1],match[2]].map(value=>translate(locale,value==='an'?'activity.target.on':'activity.target.off')).join(' → ');
 match=code==='automation.assign'||code==='automation.inherited.suspend'?assignmentTarget.exec(stored):null;
 if(match)return `${match[1]} · ${translate(locale,match[2]==='Gruppe'?'activity.target.group':'activity.target.device')}`;
 match=crossCustomerTarget.exec(stored);
 if(match){
  // The Defender bulk action stores the German operation label as its inner target: the job's label in the viewer's language.
  const inner=auditActionView(match[1]),text=inner.label==='job'&&inner.jobKind?jobActionLabel(inner.jobKind,locale,inner.jobTarget):match[1];
  return `${text} · ${translate(locale,'activity.target.devicesOf',{shown:Number(match[2]),count:Number(match[3])})}`;
 }
 return null;
}
/**
 * The readable target of a row, in this order: the account name of an internal account target (targetName, portal
 * rows); the first name-like string of a JSON object (details: one row per top-level key); the user, account, name,
 * object or reason of a key=value list (details: one row per pair); the device name of a known device id, else
 * "ID 5f3e1a2b…" in mono; "Internal account" for an internal account value without a name; a server-written text in
 * the viewer's language (translatedTarget); any other text as it is; EMPTY_VALUE for none.
 */
export function auditTargetView(entry:Pick<AuditEntry,'target'|'action'>&{targetName?:string|null},{deviceNames,locale=defaultLocale}:{deviceNames?:ReadonlyMap<string,string>;locale?:Locale}={}):AuditTargetView{
 const stored=String(entry.target??'').trim(),accountId=translate(locale,'activity.detail.accountId');
 if(entry.targetName)return {text:entry.targetName,mono:false,details:[{label:accountId,value:stored}]};
 if(!stored)return {text:EMPTY_VALUE,mono:false,details:[]};
 const object=jsonObject(stored);
 if(object){
  const name=jsonNameKeys.map(key=>object[key]).find((value):value is string=>typeof value==='string'&&value.trim()!=='');
  return {text:name??EMPTY_VALUE,mono:false,details:Object.entries(object).map(([key,value])=>({label:key,value:textOf(value)}))};
 }
 if(pairPattern.test(stored)){
  const pairs=stored.split(/\s+/).map(part=>{const index=part.indexOf('=');return {label:part.slice(0,index),value:part.slice(index+1)};});
  const named=pairNameKeys.map(key=>pairs.find(pair=>pair.label===key)).find(pair=>pair!==undefined);
  return {text:named?named.value||EMPTY_VALUE:`${pairs[0].label}=${pairs[0].value}`,mono:false,details:pairs};
 }
 if(guidPattern.test(stored)){
  const device=deviceNames?.get(stored)??deviceNames?.get(stored.toLowerCase());
  return device?{text:device,mono:false,details:[{label:'id',value:stored}]}:{text:translate(locale,'activity.target.id',{id:stored.slice(0,8)}),mono:true,details:[{label:'id',value:stored}]};
 }
 if(isInternalAccountValue(stored))return {text:translate(locale,'activity.target.internalAccount'),mono:false,details:[{label:accountId,value:stored}]};
 const translated=translatedTarget(stored,String(entry.action??''),locale);
 return {text:translated??stored,mono:false,details:[]};
}

/** One shown row: the action view, its label in the viewer's language and the target view. */
export type ActivityRowView={action:AuditActionView;label:string;target:AuditTargetView};
/** The search text of a row: the action label, the code, the target text, the account and the device name, lowercased. */
/**
 * The Area of an audit row: its customer's name, "{name} (deleted)" for a deleted customer (the name of its tombstone,
 * customerRemoved), else the portal. The table, the CSV and the detail drawer show this text.
 */
export function auditAreaText(entry:Pick<AuditEntry,'customerName'|'customerRemoved'>,locale:Locale=defaultLocale):string{
 if(!entry.customerName)return translate(locale,'audit.portal');
 return entry.customerRemoved?translate(locale,'customers.deletedArea',{name:entry.customerName}):entry.customerName;
}
export function activitySearchText(entry:Pick<AuditEntry,'actor'>,view:ActivityRowView,deviceName?:string|null):string{
 return [view.label,view.action.code,view.target.text,entry.actor,deviceName].filter(Boolean).join(' ').toLocaleLowerCase();
}

/**
 * The CSV of the shown rows (the activity table's export): UTF-8 BOM, ";" and CRLF like the fleet export; every
 * cell through cell() of ui/devices/fleet/fleet-csv.ts (quoted, formula cells neutralized), the header quoted.
 */
export function activityCsv(header:readonly string[],rows:readonly (readonly string[])[]):string{
 return '﻿'+[header.map(quote).join(';'),...rows.map(row=>row.map(value=>cell(value)).join(';'))].join('\r\n');
}
/** The file name <prefix>-YYYY-MM-DD.csv with the local date of now. */
export function activityCsvFileName(prefix:string,now:number):string{
 const date=new Date(now),pad=(value:number)=>String(value).padStart(2,'0');
 return `${prefix}-${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}.csv`;
}
