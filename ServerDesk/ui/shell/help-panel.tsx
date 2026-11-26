'use client';
import {BookOpen,CircleHelp,ExternalLink,Keyboard,Lightbulb} from 'lucide-react';
import {Drawer,Kbd} from '@/ui/kit/kit';
import {shortcutList,shortcutOr} from '@/ui/shell/console-shortcuts';
import {docsBase} from '@/ui/base/docs-base';
import type {ConsoleRoute} from '@/lib/console-route';
import {helpTopicFor,type HelpTopic} from '@/ui/shell/nav-model';
import {defaultLocale,type Locale} from '@/lib/i18n/locale';
import {translate,type MessageKey,type MessageParams} from '@/lib/i18n/translate';
import {healthWeights} from '@/ui/base/health-score';
import {useLocale} from '@/ui/base/locale';
import '@/ui/shell/help-panel.css';

type Topic={title:string;tips:string[];docs:{label:string;file:string}[]};
// Topics hold message keys (lib/i18n); topicFor translates them.
// A tip is a key, or a key with parameters (for values that live in code, like the health weights).
type TopicKeys={title:MessageKey;tips:(MessageKey|readonly [MessageKey,MessageParams])[];docs:{label:MessageKey;file:string}[]};

const doc={
 deviceWorkspace:{label:'help.doc.deviceWorkspace',file:'docs/device-workspace.md'},
 agentHealth:{label:'help.doc.agentHealth',file:'docs/agent-health.md'},
 hardwareInventory:{label:'help.doc.hardwareInventory',file:'docs/hardware-inventory.md'},
 gpuDriverUpdates:{label:'help.doc.gpuDriverUpdates',file:'docs/gpu-driver-updates.md'},
 diagnostics:{label:'help.doc.diagnostics',file:'docs/v3-diagnostics-contract.md'},
 storage:{label:'help.doc.storage',file:'docs/storage-management.md'},
 rolesFeatures:{label:'help.doc.rolesFeatures',file:'docs/roles-features.md'},
 fileBrowser:{label:'help.doc.fileBrowser',file:'docs/file-browser.md'},
 terminal:{label:'help.doc.terminal',file:'docs/terminal-live.md'},
 automation:{label:'help.doc.automation',file:'docs/automation.md'},
 desiredState:{label:'help.doc.desiredState',file:'docs/desired-state.md'},
 usageData:{label:'help.doc.usageData',file:'docs/usage-data.md'},
 customers:{label:'help.doc.customers',file:'docs/customers.md'},
 branding:{label:'help.doc.branding',file:'docs/branding.md'},
 dashboard:{label:'help.doc.dashboard',file:'docs/dashboard.md'},
 portalSessions:{label:'help.doc.portalSessions',file:'docs/portal-sessions.md'},
 maintenance:{label:'help.doc.maintenance',file:'docs/self-hosting.md#maintenance'},
 agent:{label:'help.doc.agent',file:'agent/v3/README.md'},
 deviceGroups:{label:'help.doc.deviceGroups',file:'docs/device-groups.md'},
 rbac:{label:'help.doc.rbac',file:'docs/local-identity-rbac.md'},
 mfa:{label:'help.doc.mfa',file:'docs/mfa-authenticators.md'},
 passkeys:{label:'help.doc.passkeys',file:'docs/passkeys.md'},
 deviceInventory:{label:'help.doc.deviceInventory',file:'docs/device-inventory.md'},
 alertRules:{label:'help.doc.alertRules',file:'docs/alert-rules.md'},
 notifications:{label:'help.doc.notifications',file:'docs/notifications.md'},
 tags:{label:'help.doc.tags',file:'docs/device-tags.md'},
 agentUninstall:{label:'help.doc.agentUninstall',file:'docs/native-agent-v4.md#portal-uninstall-in-490'},
 healthSignals:{label:'help.healthSignals.doc',file:'docs/device-health-signals.md'},
 vulnerabilities:{label:'help.doc.vulnerabilities',file:'docs/software-vulnerabilities.md'},
 extensions:{label:'help.doc.extensions',file:'docs/extensions.md'},
 dhcpServer:{label:'help.doc.dhcpServer',file:'docs/dhcp-server.md'},
 dnsServer:{label:'help.doc.dnsServer',file:'docs/dns-server.md'},
 releases:{label:'help.doc.releases',file:'docs/self-hosting.md#agent-releases-from-github'},
 assistant:{label:'help.doc.assistant',file:'docs/ai-assistant.md'},
 entra:{label:'help.doc.entra',file:'docs/entra-id.md'},
} as const satisfies Record<string,{label:MessageKey;file:string}>;

const deviceTopics={
 overview:{title:'help.deviceOverview.title',tips:['help.deviceOverview.tip1','help.deviceOverview.tip2','help.deviceOverview.tip3','help.deviceOverview.tip4'],docs:[doc.deviceWorkspace,doc.agentHealth]},
 hardware:{title:'help.hardware.title',tips:['help.hardware.tip1','help.hardware.tip2','help.hardware.tip3'],docs:[doc.hardwareInventory,doc.gpuDriverUpdates]},
 diagnostics:{title:'help.diagnostics.title',tips:['help.diagnostics.tip1','help.diagnostics.tip2'],docs:[doc.diagnostics]},
 management:{title:'help.management.title',tips:['help.management.tip1','help.management.tip2'],docs:[doc.storage,doc.rolesFeatures]},
 remote:{title:'help.remote.title',tips:['help.remote.tip1','help.remote.tip2'],docs:[doc.fileBrowser,doc.terminal]},
 automation:{title:'help.deviceAutomation.title',tips:['help.deviceAutomation.tip1','help.deviceAutomation.tip2'],docs:[doc.automation,doc.desiredState]},
 history:{title:'help.history.title',tips:['help.history.tip1'],docs:[doc.deviceWorkspace]},
 extensions:{title:'help.deviceExtensions.title',tips:['help.deviceExtensions.tip1','help.deviceExtensions.tip2'],docs:[doc.extensions]},
} satisfies Record<string,TopicKeys>;

const usageDataTopic:TopicKeys={title:'help.usageData.title',tips:['help.usageData.tip1','help.usageData.tip2'],docs:[doc.usageData]};
const dashboardTopic:TopicKeys={title:'help.dashboard.title',tips:['help.dashboard.tip1','help.dashboard.tip2','help.dashboard.tip3'],docs:[doc.dashboard]};
const brandingTopic:TopicKeys={title:'help.branding.title',tips:['help.branding.tip1','help.branding.tip2','help.branding.tip3'],docs:[doc.branding]};
const customersTopic:TopicKeys={title:'help.customers.title',tips:['help.customers.tip1','help.customers.tip2','help.customers.tip3'],docs:[doc.customers]};
const settingsTopic:TopicKeys={title:'help.security.title',tips:['help.security.tip1','help.security.tip2','help.security.tip3'],docs:[doc.portalSessions]};
const entraTopic:TopicKeys={title:'help.entra.title',tips:['help.entra.tip1','help.entra.tip2','help.entra.tip3','help.entra.tip4','help.entra.tip5','help.entra.tip6'],docs:[doc.entra,doc.portalSessions]};
const maintenanceTopic:TopicKeys={title:'help.maintenance.title',tips:['help.maintenance.tip1','help.maintenance.tip2','help.maintenance.tip3'],docs:[doc.maintenance]};
const automationTopic:TopicKeys={title:'help.automation.title',tips:['help.automation.tip1','help.automation.tip2','help.automation.tip3'],docs:[doc.automation,doc.desiredState]};
const releasesTopic:TopicKeys={title:'releases.title',tips:['help.releases.tip1','help.releases.tip2'],docs:[doc.releases,doc.agent]};
const extensionReleasesTopic:TopicKeys={title:'help.extensionReleases.title',tips:['help.extensionReleases.tip1','help.extensionReleases.tip2'],docs:[doc.extensions]};
const agentsTopic:TopicKeys={title:'help.agents.title',tips:['help.agents.tip1','help.agents.tip2','help.agents.tip3'],docs:[doc.agent,doc.deviceGroups]};
const accessTopic:TopicKeys={title:'help.access.title',tips:['help.access.tip1','help.access.tip2','help.access.tip3'],docs:[doc.rbac]};
const accountTopic:TopicKeys={title:'help.account.title',tips:['help.account.tip1','help.account.tip2','help.account.tip3','help.account.tip4'],docs:[doc.mfa,doc.passkeys]};
const alertRulesTopic:TopicKeys={title:'help.alertRules.title',tips:['help.alertRules.tip1','help.alertRules.tip2','help.alertRules.tip3'],docs:[doc.alertRules]};
const notificationsTopic:TopicKeys={title:'help.notifications.title',tips:['help.notifications.tip1','help.notifications.tip2','help.notifications.tip3','help.notifications.tip4'],docs:[doc.notifications,doc.alertRules]};
const vulnerabilitiesTopic:TopicKeys={title:'help.vulnerabilities.title',tips:['help.vulnerabilities.tip1','help.vulnerabilities.tip2','help.vulnerabilities.tip3'],docs:[doc.vulnerabilities]};
const alarmsTopic:TopicKeys={title:'help.alarms.title',tips:['help.alarms.tip1','help.alarms.tip2','help.alarms.tip3'],docs:[doc.alertRules]};
const assistantTopic:TopicKeys={title:'help.assistant.title',tips:['help.assistant.tip1','help.assistant.tip2','help.assistant.tip3'],docs:[doc.assistant]};
const problemsTopic:TopicKeys={title:'help.problems.title',tips:['help.problems.tip1',['help.problems.tip2',{...healthWeights}],'help.problems.tip3'],docs:[doc.alertRules]};
const healthTopics={
 software:{title:'software.title',tips:['help.software.tip1','help.software.tip2','help.software.tip3','help.software.tip4'],docs:[doc.healthSignals,doc.vulnerabilities]},
 extensions:{title:'help.extensions.title',tips:['help.extensions.tip1','help.extensions.tip2'],docs:[doc.extensions]},
 'os-support':{title:'osSupport.title',tips:['help.osSupport.tip1','help.osSupport.tip2'],docs:[doc.healthSignals]},
 encryption:{title:'encryption.title',tips:['help.encryption.tip1','help.encryption.tip2'],docs:[doc.healthSignals]},
 protection:{title:'protection.title',tips:['help.protection.tip1','help.protection.tip2','help.protection.tip3'],docs:[doc.healthSignals]},
 'device-software':{title:'software.title',tips:['help.deviceSoftware.tip1','help.deviceSoftware.tip2','help.deviceSoftware.tip3'],docs:[doc.healthSignals,doc.vulnerabilities]},
 drivers:{title:'drivers.title',tips:['help.drivers.tip1','help.drivers.tip2'],docs:[doc.healthSignals]},
 reliability:{title:'reliability.title',tips:['help.reliability.tip1','help.reliability.tip2'],docs:[doc.healthSignals]},
 certificates:{title:'certificates.title',tips:['help.certificates.tip1','help.certificates.tip2'],docs:[doc.healthSignals]},
 autostart:{title:'autostart.title',tips:['help.autostart.tip1','help.autostart.tip2','help.autostart.tip3'],docs:[doc.healthSignals]},
 'device-drivers':{title:'drivers.title',tips:['help.drivers.tip1','help.drivers.tip2'],docs:[doc.healthSignals]},
 'device-certificates':{title:'certificates.title',tips:['help.certificates.tip1','help.certificates.tip2'],docs:[doc.healthSignals]},
 'device-autostart':{title:'autostart.title',tips:['help.autostart.tip2','help.autostart.tip3'],docs:[doc.healthSignals]},
 'device-defender':{title:'device.area.defender',tips:['help.deviceDefender.tip1','help.deviceDefender.tip2','help.deviceDefender.tip3'],docs:[doc.healthSignals]},
 dhcp:{title:'help.dhcp.title',tips:['help.dhcp.tip1','help.dhcp.tip2','help.dhcp.tip3'],docs:[doc.dhcpServer,doc.extensions]},
 dns:{title:'help.dns.title',tips:['help.dns.tip1','help.dns.tip2','help.dns.tip3'],docs:[doc.dnsServer,doc.extensions]},
} satisfies Record<string,TopicKeys>;
const tagsTopic:TopicKeys={title:'help.tags.title',tips:['help.tags.tip1','help.tags.tip2','help.tags.tip3'],docs:[doc.tags,doc.deviceGroups]};
const fleetTopic:TopicKeys={title:'help.fleet.title',tips:['help.fleet.tip1','help.fleet.tip2','help.fleet.tip3','help.fleet.tip4','help.fleet.uninstall'],docs:[doc.deviceInventory,doc.deviceGroups,doc.agentUninstall]};

/** The topic of each help topic id of the navigation model (ui/shell/nav-model.ts). */
const topics:Readonly<Record<HelpTopic,TopicKeys>>={
 dashboard:dashboardTopic,fleet:fleetTopic,problems:problemsTopic,alarms:alarmsTopic,'alert-rules':alertRulesTopic,notifications:notificationsTopic,tags:tagsTopic,
 ...healthTopics,
 'device-overview':deviceTopics.overview,'device-hardware':deviceTopics.hardware,'device-diagnostics':deviceTopics.diagnostics,'device-management':deviceTopics.management,'device-remote':deviceTopics.remote,'device-automation':deviceTopics.automation,'device-history':deviceTopics.history,'device-extensions':deviceTopics.extensions,
 assistant:assistantTopic,usageData:usageDataTopic,customers:customersTopic,branding:brandingTopic,sessions:settingsTopic,entra:entraTopic,retention:maintenanceTopic,vulnerabilities:vulnerabilitiesTopic,access:accessTopic,
 automation:automationTopic,'agent-releases':releasesTopic,'extension-releases':extensionReleasesTopic,agents:agentsTopic,account:accountTopic,
};

/** The help topic of a route, in the given language: the topic of the route's node in the navigation model (helpTopicFor). Pass the route of what the console shows. */
export function topicFor(route:ConsoleRoute,locale:Locale=defaultLocale):Topic{
 const id=helpTopicFor(route),key=`${locale}:${id}`;
 let shown=translatedTopics.get(key);
 if(!shown){shown=translateTopic(topics[id],locale);translatedTopics.set(key,shown);}
 return shown;
}
// Topics and catalogs do not change at run time, so each topic is translated once per language: an open Help that
// renders again (a route change) reuses it, and the same topic is the same object.
const translatedTopics=new Map<string,Topic>();
const translateTopic=(topic:TopicKeys,locale:Locale):Topic=>({title:translate(locale,topic.title),tips:topic.tips.map(tip=>typeof tip==='string'?translate(locale,tip):translate(locale,tip[0],tip[1])),docs:topic.docs.map(({label,file})=>({label:translate(locale,label),file}))});

/**
 * The help of the current page (F1, ?, the top-bar help button): a non-modal kit Drawer, so the workspace stays
 * usable next to it and a route change shows the new page's topic without closing it. Esc closes it while focus is
 * inside it; focus then goes back to the element that had it before (the help button after a click).
 * route: what the console shows (see topicFor). The console renders it through HelpHost (ui/shell/overlay-hosts.tsx),
 * which is memoized and compares the route by value: a console render with the same route (its clock, a data
 * refresh) does not render Help again.
 */
export default function HelpPanel({open,onOpenChange,route}:{open:boolean;onOpenChange:(open:boolean)=>void;route:ConsoleRoute}){
 const [locale]=useLocale(),t=(key:MessageKey)=>translate(locale,key);
 const topic=topicFor(route,locale);
 return <Drawer open={open} onClose={()=>onOpenChange(false)} modal={false} icon={CircleHelp} title={t('help.title')} description={topic.title}>
  <div className="sd-help-body">
   <section aria-labelledby="sd-help-tips"><h3 id="sd-help-tips"><Lightbulb size={15} aria-hidden/>{t('help.onThisPage')}</h3><ul className="sd-help-tips">{topic.tips.map(tip=><li key={tip}>{tip}</li>)}</ul></section>
   <section aria-labelledby="sd-help-shortcuts"><h3 id="sd-help-shortcuts"><Keyboard size={15} aria-hidden/>{t('help.shortcuts')}</h3><dl className="sd-help-shortcuts">{shortcutList.map(item=><div key={item.label}><dt>{t(item.label)}{item.scope&&<small>{t(item.scope)}</small>}</dt><dd>{item.keys.map((key,index)=>key===shortcutOr?<span key={index}>{t(shortcutOr)}</span>:key==='–'?<span key={index}>{key}</span>:<Kbd key={index}>{key}</Kbd>)}</dd></div>)}</dl></section>
   <section aria-labelledby="sd-help-docs"><h3 id="sd-help-docs"><BookOpen size={15} aria-hidden/>{t('help.docs')}</h3><ul className="sd-help-docs">{topic.docs.map(doc=><li key={doc.file}><a href={docsBase+doc.file} target="_blank" rel="noreferrer">{doc.label}<ExternalLink size={13} aria-hidden/></a></li>)}</ul></section>
  </div>
 </Drawer>;
}
