// Catalog texts for the reasons the agent writes into snapshot.collectionErrors.
// The agent sends these reasons as English free text (agent/v3/NativeTelemetry.cs, the
// collector slots in NativeTelemetryScheduling.cs and the collector warnings). This
// pure module maps each fixed sentence and each sentence pattern to an agentReason.*
// key. A Windows detail in parentheses, a log or drive name and a network adapter alias
// stay as received. A text that matches no entry is unknown: the console shows it as
// received, in mono, so the user can tell agent text from console text.
import type {MessageKey} from '@/lib/i18n/messages/en';
import type {Locale} from '@/lib/i18n/locale';
import {translate} from '@/lib/i18n/translate';

/** The collector names of NativeTelemetry.cs (the first argument of each collector slot). */
export const agentCollectorNames:Readonly<Record<string,MessageKey>>={
 'Performance counters':'agentReason.collector.performanceCounters',
 'Graphics cards':'agentReason.collector.graphicsCards',
 'Processes':'agentReason.collector.processes',
 'Drives':'agentReason.collector.drives',
 'Services':'agentReason.collector.services',
 'Event logs':'agentReason.collector.eventLogs',
 'Network':'agentReason.collector.network',
 'System inventory':'agentReason.collector.systemInventory',
 'Hardware inventory':'agentReason.collector.hardwareInventory',
 'Roles and features':'agentReason.collector.rolesAndFeatures',
 'Local accounts':'agentReason.collector.localAccounts',
 'Page file':'agentReason.collector.pageFile',
 'Security':'agentReason.collector.security',
 'Local firewall rules':'agentReason.collector.firewallRules',
 'Scheduled tasks':'agentReason.collector.scheduledTasks',
 'Scheduled system action':'agentReason.collector.scheduledSystemAction',
 'Crashes':'agentReason.collector.crashes',
 'BitLocker':'agentReason.collector.bitlocker',
 'Software inventory':'agentReason.collector.softwareInventory',
 'Drivers':'agentReason.collector.drivers',
 'Reliability':'agentReason.collector.reliability',
 'Disk and battery health':'agentReason.collector.diskAndBatteryHealth',
 'Certificates':'agentReason.collector.certificates',
 'Autostart':'agentReason.collector.autostart',
 'Defender':'agentReason.collector.defender',
};

/** The items of NativeNetworkInventory.cs that a "Network partly readable" warning names. */
export const agentNetworkDetails:Readonly<Record<string,MessageKey>>={
 'Adapter type':'agentReason.networkDetail.adapterType',
 'Connection state':'agentReason.networkDetail.connectionState',
 'DNS-Server':'agentReason.networkDetail.dnsServers',
 'Description':'agentReason.networkDetail.description',
 'Gateways':'agentReason.networkDetail.gateways',
 'IP addresses':'agentReason.networkDetail.ipAddresses',
 'IP properties':'agentReason.networkDetail.ipProperties',
 'IPv4 addresses':'agentReason.networkDetail.ipv4Addresses',
 'IPv4 binding':'agentReason.networkDetail.ipv4Binding',
 'IPv4 properties':'agentReason.networkDetail.ipv4Properties',
 'IPv6 adapter index':'agentReason.networkDetail.ipv6AdapterIndex',
 'IPv6 binding':'agentReason.networkDetail.ipv6Binding',
 'MAC address':'agentReason.networkDetail.macAddress',
 'Name':'agentReason.networkDetail.name',
 'Speed':'agentReason.networkDetail.speed',
 'The number of adapters exceeds the inventory limit':'agentReason.networkDetail.adapterLimit',
 'IPv4 adapter index not available':'agentReason.networkDetail.ipv4IndexMissing',
 'IPv6 adapter index not available':'agentReason.networkDetail.ipv6IndexMissing',
 'IPv4 address or prefix not readable':'agentReason.networkDetail.ipv4AddressUnreadable',
 'The IPv4 configuration exceeds the management limit':'agentReason.networkDetail.ipv4ConfigLimit',
};

/**
 * The agent sentences: a fixed text, or a pattern whose {name} parts match any text. A part
 * listed in `lookup` must be a known collector name or network item; it is translated too.
 * Order matters: the specific "System event log … for disk errors" comes before "{log} event log".
 */
export const agentReasonPatterns:readonly {key:MessageKey;text:string;lookup?:Readonly<Record<string,Readonly<Record<string,MessageKey>>>>}[]=[
 // NativeTelemetry.cs: CollectAsync, CreateBaseSnapshot and LimitSnapshot.
 {key:'agentReason.processList',text:'The process list is being initialized or is not available at the moment.'},
 {key:'agentReason.updateInventory',text:'The last update inventory could not be read.'},
 {key:'agentReason.systemInventory',text:'The system inventory is being initialized; available data loads independently.'},
 {key:'agentReason.largeInventory',text:'Very large inventory: groups, firewall rules and tasks were shortened for this heartbeat.'},
 // NativeCrashInventory.cs.
 {key:'agentReason.eventLogs',text:'The event logs could not be read ({detail}).'},
 {key:'agentReason.minidumpFolder',text:'The minidump folder could not be read ({detail}).'},
 // NativeDiskHealth.cs, before the general event log pattern.
 {key:'agentReason.systemLogDiskErrors',text:'The System event log could not be read for disk errors ({detail}).'},
 {key:'agentReason.eventLog',text:'The {log} event log could not be read ({detail}).'},
 {key:'agentReason.diskHealth',text:'The disk health could not be read ({detail}).'},
 {key:'agentReason.partitions',text:'The partitions could not be read ({detail}).'},
 // NativeAutostartInventory.cs, NativeCertificates.cs, NativeDefender.cs, NativeReliability.cs.
 {key:'agentReason.autostartEntries',text:'The autostart entries could not be read completely: {what} ({detail}).'},
 {key:'agentReason.httpSysBindings',text:'The http.sys bindings could not be read ({detail}).'},
 {key:'agentReason.rdpCertificate',text:'The Remote Desktop certificate could not be read ({detail}).'},
 {key:'agentReason.defenderDetections',text:'The Defender detections could not be read ({detail}).'},
 {key:'agentReason.defenderThreatNames',text:'The Defender threat names could not be read ({detail}).'},
 {key:'agentReason.defenderExclusions',text:'The Defender exclusions could not be read ({detail}).'},
 {key:'agentReason.securityCenter',text:'The Security Center antivirus products could not be read ({detail}).'},
 {key:'agentReason.failedInstallations',text:'The failed installations could not be read ({detail}).'},
 // NativeTelemetryProviders.cs.
 {key:'agentReason.driveUnavailable',text:'Drive {drive} is not available at the moment.'},
 // NativeNetworkInventory.cs.
 {key:'agentReason.networkPartlyAlias',text:'Network partly readable · {alias}: {item} ({kind}).',lookup:{item:agentNetworkDetails}},
 {key:'agentReason.networkPartly',text:'Network partly readable: {item} ({kind}).',lookup:{item:agentNetworkDetails}},
 {key:'agentReason.networkMore',text:'Network: {count} more adapter details could not be read.'},
 // NativeTelemetryScheduling.cs: the reading of a collector slot.
 {key:'agentReason.collectorTimeout',text:'{name}: the Windows provider does not answer in time; the collection continues independently.',lookup:{name:agentCollectorNames}},
 {key:'agentReason.collectorStale',text:'{name}: the last successful state is out of date.',lookup:{name:agentCollectorNames}},
 {key:'agentReason.collectorStarting',text:'{name} is being initialized.',lookup:{name:agentCollectorNames}},
 {key:'agentReason.collectorFailed',text:'{name} could not be read ({detail}).',lookup:{name:agentCollectorNames}},
];

const escape=(text:string)=>text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const compiled=agentReasonPatterns.map(pattern=>{
 const names:string[]=[];
 // A {detail} in parentheses is greedy, so a Windows detail that holds parentheses stays whole.
 const source=pattern.text.split(/(\{\w+\})/).map(part=>{const name=/^\{(\w+)\}$/.exec(part)?.[1];if(!name)return escape(part);names.push(name);return name==='detail'||name==='kind'?'(.*)':'(.+?)';}).join('');
 return {...pattern,names,regex:new RegExp('^'+source+'$','s')};
});

/** The catalog key and params of an agent sentence, or null when the sentence is not known. */
export function agentReasonMatch(text:string):{key:MessageKey;params:Record<string,string>;lookups:Record<string,MessageKey>}|null{
 const trimmed=text.trim();
 for(const pattern of compiled){
  const match=pattern.regex.exec(trimmed);
  if(!match)continue;
  const params:Record<string,string>={},lookups:Record<string,MessageKey>={};
  let known=true;
  pattern.names.forEach((name,index)=>{
   const value=match[index+1];params[name]=value;
   const table=pattern.lookup?.[name];
   if(table){if(Object.hasOwn(table,value))lookups[name]=table[value];else known=false;}
  });
  if(known)return {key:pattern.key,params,lookups};
 }
 return null;
}

/** One agent reason in the console language; an unknown reason comes back as received and marked. */
export type AgentReasonLine={known:boolean;text:string};
export function agentReasonLine(locale:Locale,text:string):AgentReasonLine{
 const match=agentReasonMatch(text);
 if(!match)return {known:false,text};
 const params:Record<string,string|number>={...match.params,...Object.fromEntries(Object.entries(match.lookups).map(([name,key])=>[name,translate(locale,key)]))};
 if('count' in params)params.count=Number(params.count);
 return {known:true,text:translate(locale,match.key,params)};
}

/** The reasons of a snapshot: the translated known lines and the unknown lines as received, each in order. */
export function agentReasonLines(locale:Locale,texts:readonly string[]):{known:string[];unknown:string[]}{
 const known:string[]=[],unknown:string[]=[];
 for(const text of texts){const line=agentReasonLine(locale,text);(line.known?known:unknown).push(line.text);}
 return {known,unknown};
}
