import type {AlertIssue,AlertIssueParams,AlertLevel} from './alert-rules';
import type {EffectiveTag} from './tags';
import type {PluginReleaseSummary} from './plugin-catalog';
import type {AgentIntegrityKind,AgentIntegrityReason,AgentIntegrityService,AgentIntegrityTarget,AgentStartType} from './agent-integrity-contract';
import type {DeviceNameSource} from './device-name';
import type {PortalCertificateView} from './server/agent/portal-certificate';
import type {ConsoleBranding} from './branding';
import type {DashboardPreference} from './dashboard-layout';
/** An open alarm as GET /api/console sends it (lib/server/devices/alerts.ts). muted is null once its time is up. */
export type OpenAlert={id:string;ruleId:string;key:string;level:AlertLevel;peakLevel:AlertLevel;peakValue:number|null;threshold:number|null;params:AlertIssueParams;startedAt:number;openedAt:number|null;acknowledged:{at:number;by:string}|null;muted:{until:number;by:string}|null};
/** One row of the device alarm history (GET /api/alerts): an open or closed alarm. */
export type AlertHistoryEntry=OpenAlert&{state:'open'|'closed';closedAt:number|null;closeReason:'recovered'|'rule-off'|'no-data'|null};
export type Disk = {name:string; label:string; totalGb:number; freeGb:number};
export type Service = {name:string; displayName:string; status:string; startMode:string};
export type WindowsFeature = {
 name:string;displayName:string;installed:boolean;featureType:string;
 parent?:string|null;subFeatures?:string[];depth?:number;
};
export type ProcessSnapshot = {
 name:string;pid:number;memoryMb:number;cpuSeconds:number|null;
 startedAt?:string;parentPid?:number;sessionId?:number;user?:string|null;path?:string|null;
 cpuPercent?:number|null;protected?:boolean;
};
export type ProcessInventory = {
 collectedAt:string;count:number;truncated:boolean;complete:boolean;intervalSeconds:number;error?:string;
};
export type GpuSnapshot = {
 id:string;name:string;vendor:'nvidia'|'amd'|'intel';utilization:number|null;collectedAt:string;
};
export type GpuDetails = {
 id:string;collectedAt:string;
 driverVersion?:string|null;vendorDriverVersion?:string|null;driverModel?:string|null;vbiosVersion?:string|null;
 vendorId?:number|null;deviceId?:number|null;subsystemId?:number|null;revision?:number|null;pciBusId?:string|null;
 dedicatedMemoryBytes?:number|null;sharedMemoryBytes?:number|null;dedicatedMemoryUsedBytes?:number|null;sharedMemoryUsedBytes?:number|null;
 temperatureCelsius?:number|null;coreClockMhz?:number|null;memoryClockMhz?:number|null;powerWatts?:number|null;powerLimitWatts?:number|null;fanPercent?:number|null;
 pcieGeneration?:number|null;pcieMaxGeneration?:number|null;pcieLinkWidth?:number|null;pcieMaxLinkWidth?:number|null;memoryBusWidthBits?:number|null;cudaCores?:number|null;
 sensorProvider?:'windows'|'nvidia-nvml'|null;
};
export type HardwareCpu = {id:string;name:string;manufacturer:string|null;cores:number|null;threads:number|null;maxClockMhz:number|null;socket:string|null};
export type HardwareMemoryModule = {id:string;deviceLocator:string|null;bankLabel:string|null;capacityBytes:number|null;speedMhz:number|null;configuredClockMhz:number|null;formFactor:string|null;memoryType:string|null;manufacturer:string|null;partNumber:string|null;serialNumber:string|null};
export type HardwarePhysicalDisk = {id:string;model:string|null;serialNumber:string|null;sizeBytes:number|null;busType:string|null;mediaType:string|null;healthStatus:'healthy'|'warning'|'unhealthy'|'unknown'|null;firmwareVersion:string|null};
export type HardwareSystem = {manufacturer:string|null;model:string|null;systemType:string|null;uuid:string|null};
export type HardwareBios = {manufacturer:string|null;name:string|null;version:string|null;releasedAt:string|null;serialNumber:string|null};
export type HardwareBaseboard = {manufacturer:string|null;product:string|null;version:string|null;serialNumber:string|null};
export type HardwareNetworkAdapter = {id:string;name:string|null;manufacturer:string|null;mac:string|null;speedMbps:number|null;physicalAdapter:boolean|null};
export type HardwareInventory = {
 collectedAt:string;intervalSeconds:number;complete:boolean;errors?:string[];
 cpus?:HardwareCpu[];memoryModules?:HardwareMemoryModule[];memoryArray?:{slots:number|null;maxCapacityBytes:number|null};
 disks?:HardwarePhysicalDisk[];system?:HardwareSystem;bios?:HardwareBios;baseboard?:HardwareBaseboard;networkAdapters?:HardwareNetworkAdapter[];
};
// Health signals of agent 4.10.0 (docs/v3-health-signals.md). All optional on the wire.
export type CrashKind='bugcheck'|'unexpected-shutdown'|'hardware-error';
export type CrashEntry = {
 id:string;kind:CrashKind;at:string;stopCode:number|null;parameters:string[]|null;
 driver:{name:string;version:string|null;manufacturer:string|null}|null;
 source:'event'|'minidump'|'event+minidump';dumpFile:string|null;dumpStatus:'parsed'|'unreadable'|'too-large'|'none';detail:string|null;
};
export type CrashInventory = {collectedAt:string;windowDays:30;complete:boolean;truncated:boolean;error?:string};
export type OsInfo = {editionId:string|null;installationType:string|null;displayVersion:string|null;ubr:number|null;productName:string|null;currentBuild:string|null};
export type BitLockerConversion='decrypted'|'encrypted'|'encrypting'|'decrypting'|'paused-encrypting'|'paused-decrypting'|'unknown';
export type BitLockerProtection='on'|'off'|'suspended'|'unknown';
export type BitLockerMethod='none'|'aes-128-diffuser'|'aes-256-diffuser'|'aes-128'|'aes-256'|'hardware'|'xts-aes-128'|'xts-aes-256'|'unknown';
export type BitLockerProtector='tpm'|'tpm-pin'|'tpm-startup-key'|'tpm-pin-startup-key'|'external-key'|'numerical-password'|'passphrase'|'public-key'|'tpm-certificate'|'ad-account'|'unknown';
export type BitLockerVolume = {drive:string|null;volumeType:'os'|'fixed'|'removable';conversion:BitLockerConversion;percent:number|null;protection:BitLockerProtection;method:BitLockerMethod;protectors:BitLockerProtector[];suspendedSince:string|null};
export type BitLockerState = {available:boolean;reason?:'not-supported'|'access-denied'|'error';collectedAt:string;volumes:BitLockerVolume[]};
// Health signals of agent 4.11.0 (docs/v3-health-signals.md). All optional on the wire.
/** A device with an error in Device Manager. key: the first 16 hex characters of the SHA-256 of its PNPDeviceID (never sent itself). */
export type DeviceProblem = {key:string;name:string;class:string|null;code:number;manufacturer:string|null};
export type UnsignedDriver = {key:string;deviceName:string;infName:string|null;file:string|null;provider:string|null;version:string|null};
/** The driver summary of the snapshot; the full list goes to POST /api/agent/drivers (lib/driver-inventory.ts). */
/** One collector whose most recent run failed (agent 4.11.1, docs/v3-health-signals.md). */
export type CollectorErrorCode='timeout'|'access-denied'|'not-supported'|'broker-unavailable'|'error';
export type CollectorError={collector:string;code:CollectorErrorCode;since:string;lastAt:string;failures:number;elapsedMs:number|null};
export type DriverHealth = {collectedAt:string;checksum:string;count:number;truncated:boolean;unsignedCount:number;unsigned:UnsignedDriver[];problems:DeviceProblem[];problemsTruncated:boolean};
export type ReliabilityEventKind='crash'|'hang'|'install-failure';
export type ReliabilityEvent = {at:string;kind:ReliabilityEventKind;program:string;version:string|null;module:string|null;moduleVersion:string|null};
export type StabilityUnavailableReason='collection-disabled'|'not-supported'|'access-denied'|'error';
export type StabilityState = {available:true;current:number;days:{day:string;index:number}[]}|{available:false;reason:StabilityUnavailableReason};
export type Reliability = {collectedAt:string;windowDays:30;stability:StabilityState;events:ReliabilityEvent[];truncated:boolean};
export type DiskMediaType='ssd'|'hdd'|'scm'|'unspecified';
export type DiskHealthState='healthy'|'warning'|'unhealthy'|'unknown';
export type DiskOperationalStatus='ok'|'degraded'|'stressed'|'predictive-failure'|'failed'|'starting'|'stopping'|'stopped'|'in-service'|'no-contact'|'lost-communication'|'aborted'|'dormant'|'supporting-entity-in-error'|'completed'|'power-mode'|'unknown';
/** One physical disk. A counter the disk does not report is null, never 0. */
export type PhysicalDiskHealth = {
 id:string;number:number|null;model:string;busType:string;mediaType:DiskMediaType;health:DiskHealthState;operationalStatus:DiskOperationalStatus[];driveLetters:string[];
 countersAvailable:boolean;wearPercent:number|null;temperatureC:number|null;temperatureMaxC:number|null;readErrorsUncorrected:number|null;powerOnHours:number|null;
};
export type DiskEvent = {at:string;source:'disk'|'ntfs';eventId:number;disk:number|null;volume:string|null};
/** counts: events per disk number (or "unknown") over the whole 30-day window. */
export type DiskHealth = {collectedAt:string;disks:PhysicalDiskHealth[];events:{windowDays:30;items:DiskEvent[];counts:Record<string,number>;truncated:boolean}};
export type BatteryInfo = {id:number;name:string|null;designCapacityMWh:number|null;fullChargeCapacityMWh:number|null;healthPercent:number|null;cycleCount:number|null};
export type BatteryState = {collectedAt:string;present:boolean;reason?:'no-battery'|'not-supported'|'access-denied'|'error';batteries:BatteryInfo[]};
export type CertificateStore='My'|'WebHosting'|'Remote Desktop';
export type CertificateBinding = {type:'https';endpoint:string}|{type:'rdp';endpoint:'RDP-Tcp'};
/** A machine certificate. Private keys and certificate files never leave the device. */
export type CertificateEntry = {thumbprint:string;stores:CertificateStore[];subject:string;sans:string[];issuer:string;notBefore:string;notAfter:string;hasPrivateKey:boolean;selfSigned:boolean;bindings:CertificateBinding[]};
export type CertificateInventory = {collectedAt:string;items:CertificateEntry[];truncated:boolean};
export type AutostartCategory='run'|'run-once'|'startup-folder'|'winlogon'|'service'|'task';
/**
 * The broker's integrity check in the heartbeat (agent 4.18.0, lib/server/agent/telemetry.ts): when it ran, the start type
 * of both services and the protection differences still open after its repair (at most 16).
 */
export type AgentIntegritySnapshot={checkedAt:string;services:{service:AgentIntegrityService;startType:AgentStartType}[];findings:{target:AgentIntegrityTarget;service?:AgentIntegrityService}[]};
/** One stored integrity event of a device (lib/server/agent/agent-integrity.ts); planned events are never read for the alarms. */
export type AgentIntegrityEvent={id:string;kind:AgentIntegrityKind;service:AgentIntegrityService|null;target:AgentIntegrityTarget|null;startType:'manual'|'disabled'|'unknown'|null;reason:AgentIntegrityReason|null;user:string|null;finding:string|null;repaired:boolean|null;occurredAt:number;receivedAt:number};
/** The autostart summary GET /api/console adds per visible device (lib/server/devices/autostart.ts); the two autostart rules use it. */
/** The stored DHCP data the two DHCP alert rules read (consoleDhcpAlerts in lib/server/extensions/plugin-data.ts): IPv4 scopes only. */
export type DhcpAlertData={service:'running'|'stopped'|null;collectedAt:number;scopes:{scopeId:string;state:'active'|'inactive';inUse:number;total:number;percent:number}[]};
/** The stored DNS data the alert rule DNS service stopped reads (consoleDnsAlerts in lib/server/extensions/dns-data.ts). */
export type DnsAlertData={service:'running'|'stopped'|null;collectedAt:number};
export type AutostartSummary = {reportedAt:number;count:number;newCount:number;suspiciousNewCount:number;newEntries:{id:string;name:string;category:AutostartCategory;suspicious:boolean;firstSeen:number}[]};
/** A known server product found in the software inventory of a device (lib/extensions.ts, matchServerSoftware). */
export type ServerSoftwareMatch = {id:string;version:string|null;names:string[]};
export type OsSupportStatus='supported'|'ending'|'ended'|'unknown';
export type OsSupportChannel='home-pro'|'enterprise-education'|'ltsc'|'server';
/** The support status the console computes per device at response time (lib/os-support.ts). */
export type OsSupport = {
 status:OsSupportStatus;reason?:'no-entry'|'not-reported';
 entry?:{id:string;product:string;version:string;channel:OsSupportChannel;generalEnd:string;securityEnd:string;source:string};
 effectiveEnd?:string;daysLeft?:number;
 esu?:{until:string;origin:{type:'customer'|'group'|'device';id:string;name:string}};
};
// Microsoft Defender of agent 4.14.0 (lib/server/agent/telemetry.ts defenderState). detections and exclusions need defender.read.
export type DefenderMode='normal'|'passive'|'sxs-passive'|'edr-block'|'not-running'|'unknown';
export type DefenderSeverity='low'|'moderate'|'high'|'severe'|'unknown';
export type DefenderThreatStatus='detected'|'cleaned'|'quarantined'|'removed'|'allowed'|'blocked'|'failed'|'abandoned'|'unknown';
export type DefenderDetection={id:string;threatId:string;name:string|null;severity:DefenderSeverity;status:DefenderThreatStatus;active:boolean;path:string|null;resourceCount:number;at:string|null;user:string|null};
export type DefenderExclusions={paths:string[];extensions:string[];processes:string[]};
export type DefenderUnavailable={available:false;reason?:'not-installed'|'access-denied'|'error';collectedAt:string};
export type DefenderAvailable={available:true;collectedAt:string;mode:DefenderMode;antivirusEnabled:boolean;realTimeProtection:boolean;tamperProtected:boolean|null;
 quickScanAt:string|null;fullScanAt:string|null;signatureAt:string|null;signatureVersion:string|null;productVersion:string|null;
 otherAntivirus:{name:string;enabled:boolean}[]|null;detectionCount:number;activeCount:number;highestActiveSeverity:DefenderSeverity|null;truncated:boolean;
 /** Absent in the console answer without defender.read. */
 detections?:DefenderDetection[];
 /** Absent in the console answer without defender.read; null when the agent could not read them. */
 exclusions?:DefenderExclusions|null};
export type DefenderState=DefenderUnavailable|DefenderAvailable;
// Windows activation of agent 4.22.0 (lib/server/agent/telemetry.ts windowsLicenseState). No product key is ever sent.
export type WindowsLicenseStatus='unlicensed'|'licensed'|'initial-grace'|'additional-grace'|'non-genuine-grace'|'notification'|'extended-grace'|'unknown';
export type WindowsLicenseChannel='evaluation'|'oem'|'volume-kms'|'volume-mak'|'retail'|'unknown';
/** expiresAt: collection time + the remaining minutes (evaluation end while licensed, else the grace end); evaluationEndsAt: EvaluationEndDate. */
export type WindowsLicenseAvailable={available:true;collectedAt:string;status:WindowsLicenseStatus;channel:WindowsLicenseChannel;expiresAt:string|null;evaluationEndsAt:string|null};
export type WindowsLicense={available:false;reason:'not-found'|'access-denied'|'error';collectedAt:string}|WindowsLicenseAvailable;
/** A scan the portal started that still runs (agent 4.15.0, lib/server/agent/telemetry.ts defenderScanState). */
export type DefenderScan={kind:'quick'|'full';startedAt:string};
export type ServerSnapshot = {
 hostname:string; os:string; build:string; manufacturer:string; model:string; domain:string; cores:number; memoryGb:number;
 cpu:number|null; memory:number; uptimeSeconds:number; rebootPending:boolean; management:boolean;
 rebootReasons?:('windows-servicing'|'windows-update'|'file-replacement'|'file-operations-unknown')[];pendingFileOperationsCount?:number;
 disks:Disk[]; services:Service[]; processes:ProcessSnapshot[];processInventory?:ProcessInventory;gpus?:GpuSnapshot[];gpuDetails?:GpuDetails[];hardware?:HardwareInventory;
 events:{id:number; level:string; source:string; message:string; at:string}[];
 networks:{name:string; addresses:string[]; mac:string; speedMbps:number}[];
 hotfixes:{id:string; installedOn:string}[]; collectionErrors:string[];
 protocolVersion:3;agentVersion:string;mode:'ReadOnly'|'Management';agentCapabilities:string[];agentIsolation?:{split:boolean;brokerVersion:string;account:string;elevated:boolean;privileges:string[]};
 publicKey?:{kty:'RSA';n:string;e:string};
 features?:WindowsFeature[];
 localUsers?:{name:string;sid:string;enabled:boolean;fullName:string;description:string;passwordExpires:boolean;lastLogon:string}[];
 localGroups?:{name:string;sid:string;members:string[]}[];
 networkConfig?:{interfaceIndex:number;alias:string;dhcp:boolean;addresses:{address:string;prefixLength:number}[];gateway:string[];dns:string[];status:string}[];
 pagefile?:{automatic:boolean;files:{name:string;initialMb:number;maximumMb:number;allocatedMb:number;currentUsageMb:number;peakUsageMb:number}[]};
 rdp?:{enabled:boolean;nla:boolean;port:number;policyBlocked:boolean};
 security?:{domainJoined:boolean;domainRole:number;rdpEnabled:boolean;firewall:{name:string;enabled:boolean}[];defender:{available:boolean;enabled:boolean;signatureAt:string;realTimeProtection:boolean};lastBoot:string;/** Agent 4.19.0 (docs/plugin-ad-sign-in.md): the domain of a member or DC, else the computer of a workgroup server, read locally through LSA. */directory?:{kind:'domain'|'local';name:string;netbiosName:string;sid:string}};
 firewallRules?:{name:string;displayName:string;enabled:boolean;direction:string;action:string;protocol:string;port:string;remoteAddress:string}[];
 powerSchedule?:{id:string;operation:'shutdown'|'restart';scheduledAt:string;reason:string}|null;
 tasks?:{name:string;path:string;state:string;lastRun:string;nextRun:string;lastResult:number}[];
 updates?:{checkedAt:string;pendingCount:number;items:{id:string;title:string;kb:string;severity:string;rebootRequired:boolean}[]};
 performance?:{diskReadBytesSec:number|null;diskWriteBytesSec:number|null;networkBytesSec:number|null;diskLatencyMs:number|null;processorQueue:number|null;pagefilePercent:number|null};
 osInfo?:OsInfo;crashes?:CrashEntry[];crashInventory?:CrashInventory;bitlocker?:BitLockerState;
 /** SHA-256 of the software list (lib/software-inventory.ts); null before the first collection. The list itself goes to POST /api/agent/software. */
 softwareChecksum?:string|null;
 driverHealth?:DriverHealth;collectorErrors?:CollectorError[];reliability?:Reliability;diskHealth?:DiskHealth;battery?:BatteryState;certificates?:CertificateInventory;defender?:DefenderState;
 /** Windows activation (agent 4.22.0); absent for older agents. */
 windowsLicense?:WindowsLicense;
 /** Present only while a scan that the portal started still runs. */
 defenderScan?:DefenderScan;
 /** SHA-256 of the autostart list (lib/autostart-inventory.ts); null before the first collection. The list itself goes to POST /api/agent/autostart. */
 autostartChecksum?:string|null;
 /**
  * The agent plugins the SYSTEM broker reports (agent 4.16.0, docs/agent-plugins.md), at most 16: name, target,
  * version and capabilities from the verified signed manifest. state ready: the signature, the hash and the folder ACL
  * held at the last check (at most 15 minutes old); damaged: one failed, error is its AGENT_PLUGIN_* code.
  * networkBlocked: both Windows Firewall rules that block the plugin EXE exist. Read the target with
  * pluginReportTarget (lib/plugin-catalog.ts).
  */
 plugins?:{name:string;
  /** The detection id the plugin extends (lib/extensions.ts); the heartbeat schema sets it from the agent's role. */
  target?:string;
  /** Only in snapshots stored before target existed: the agent's role, which the target replaces. */
  role?:string;
  version:string;capabilities:string[];state:'ready'|'damaged';networkBlocked:boolean;error?:string}[];
 /** The broker's integrity check (agent 4.18.0): start types and open protection differences. Absent for older agents. */
 agentIntegrity?:AgentIntegritySnapshot;
};
export type DeviceGroupReference={id:string;name:string;parentId:string|null;depth:number;direct:boolean};
export type DeviceGroup={id:string;name:string;description:string;parentId:string|null;depth:number;deviceCount:number;permissions:string[];/** The group's customer (device_groups.customer_id), for the customer folders in the device tree. */customerId?:string;/** Whether deleting the group asks for a fresh MFA proof: it has a device or a devicegroup role assignment (deviceGroupDeleteNeedsStepUp in lib/step-up.ts). */stepUpOnDelete?:boolean};
export type Server = {id:string; name:string; createdAt:number; lastSeen:number|null; revoked:number; management:number; snapshot:ServerSnapshot|null;/** The device's customer, so catalogs can filter targets. */customerId?:string;/** The customer's name, only once a second customer exists (ConsoleData.multipleCustomers). */customerName?:string;/** True if the device's customer is disabled; set together with customerName. */customerDisabled?:boolean;/** Only for a never-connected device: when its registration expires (null: no expiry). */registration?:{expiresAt:number|null};permissions?:string[];groupId?:string|null;groupName?:string|null;groups?:DeviceGroupReference[];/** Issues the server evaluated from the alert rules at response time (lib/alert-rules.ts); [] without a snapshot. */issues?:AlertIssue[];/** The open alarms of the device (lib/server/devices/alerts.ts); pending and closed alarms are never sent here. */alerts?:OpenAlert[];/** Free text of the portal (lib/device-description.ts); '' when empty. */description?:string;/** Where name comes from (lib/device-name.ts): the reported computer name, a custom name, or pending until the first heartbeat of a personal registration. */nameSource?:DeviceNameSource;/** The last names before a rename, newest first, at most 5 (device_previous_names). */previousNames?:string[];/** Effective tags, own and inherited from the group path (effectiveDeviceTags in lib/server/devices/tag-store.ts), sorted by name. */tags?:EffectiveTag[];/** The operating system support status, computed at response time with the device's ESU date (lib/os-support.ts). */osSupport?:OsSupport;/** The stored autostart list in short: new and suspicious new entries (lib/server/devices/autostart.ts); absent before the first report. */autostart?:AutostartSummary;/** The stored DHCP data for the DHCP alert rules (lib/server/extensions/plugin-data.ts); only during the evaluation, never in the console row. */dhcpAlerts?:DhcpAlertData;/** The stored DNS data for the DNS alert rule (lib/server/extensions/dns-data.ts); only during the evaluation, never in the console row. */dnsAlerts?:DnsAlertData;/** The stored integrity events for the agent alert rules (consoleAgentIntegrity in lib/server/agent/agent-integrity.ts); only during the evaluation, never in the console row. */agentIntegrity?:{events:AgentIntegrityEvent[]};/** The known server products of the software inventory (lib/server/extensions/server-role-software.ts); absent when none matches. The Extensions area and scope tab use it (lib/extensions.ts). */serverSoftware?:ServerSoftwareMatch[];maintenance?:{state:'scheduled'|'queued'|'updating';version:string;notBefore:number}};
export type DevicePermissionTarget=Pick<Server,'id'|'name'|'groupId'|'groupName'|'groups'|'customerId'>;
export type Job = {id:string; serverId:string; action:string; target:string; state:string; createdAt:number; claimedAt:number|null; result:string|null;/** Agent message code and arguments of the result (lib/agent-messages.ts); null for older agents. */resultCode?:string|null;resultArgs?:Record<string,string>|null; actor:string;lastProgress?:number|null;notBefore?:number;outputRedacted?:boolean;/** The object of the job in the admin's words (jobObject in lib/job-display.ts), null when it has none. */object?:string|null;metadata?:{runbookRunId:string;completedSteps:number;totalSteps:number;currentStep?:number;currentStepName?:string;cancelRequested?:boolean;finishedAt?:number}};
/** identitySource: 'entra' for an account from Microsoft Entra ID (docs/entra-id.md); entra carries its own IDs and email for the account page. */
export type Viewer = {id:string; label:string;userId?:string;username?:string;displayName?:string;principal?:string;permissions?:string[];canManageDeviceGroups?:boolean;identitySource?:'local'|'entra';entra?:{tenantId:string;objectId:string;email:string};/** The names of the roles assigned to the account (directly or through a user group), sorted (userViewer). */roles?:string[];authorization?:{authVersion:number;sessionHash?:string}};
export type Sample = {at:number; cpu:number|null; memory:number|null; serverId:string;gpus?:GpuSnapshot[]};
export type AuditEntry={id:number;at:number;actor:string;action:string;target:string;serverId:string|null;scope:'portal'|'device';/** The row's customer (device rows and customer entries). */customerId?:string|null;customerName?:string|null;/** True when customerName is the last name of a deleted customer (removed_customers). */customerRemoved?:boolean;/** The shown name of an internal account target (portal entries only, GET /api/console). */targetName?:string|null};
/** State of the daily maintenance (lib/server/maintenance-runs.ts). Only Owners get it. */
export type MaintenanceStatus={lastSuccessAt:number|null;lastRun:{startedAt:number;finishedAt:number|null;status:'running'|'succeeded'|'failed'}|null;stale:boolean};
/** The most devices one account can pin (lib/server/pinned-devices.ts, docs/device-workspace.md "Pinned devices"). */
export const pinnedDeviceLimit=20;
export type ConsoleData = {servers:Server[];deviceGroups?:DeviceGroup[];permissionDevices?:DevicePermissionTarget[];customers?:{id:string;name:string}[]; jobs:Job[]; audit:AuditEntry[];deviceAudit?:AuditEntry[];viewer:Viewer;auth:{mode:'local';origin:string};maintenance?:MaintenanceStatus;/** Only for Owners, only true: SESSION_SECRET_PREVIOUS is still set but no stored secret needs it (runtime/previous-secret.mjs). */previousSecretRemovable?:boolean;/** True once a customer other than the default customer exists (customerSeparationSql in runtime/customer-separation.mjs). */multipleCustomers?:boolean;/** Only for global Owners: the emergency sign-ins that no Owner acknowledged yet (lib/server/identity/security-alarms.ts). */emergencyAlarms?:{open:number;latest:{id:string;at:number;displayName:string;address:string;own:boolean}|null};/** The newest active release of each agent plugin (latestPluginReleases in lib/server/extensions/plugin-releases.ts), metadata only; the Extensions area and scope tab use it. */pluginReleases?:PluginReleaseSummary[];/** Only for Owners: the portal's own root certificate without the certificate itself (portalCertificateView in lib/server/agent/portal-certificate.ts), null without a local CA; the page Add device shows it. */portalCertificate?:PortalCertificateView|null;/** The portal images and the logos of the customers the viewer sees, only those with a logo (consoleBranding in lib/server/branding.ts); customers stays empty without multiple customers. */branding?:ConsoleBranding;/** The viewer's own display preferences (accountPreferences in lib/server/account-preferences.ts): consoleBackground is true without a stored row; pinnedDeviceIds are the visible pins, oldest first (pinnedDeviceIds in lib/server/pinned-devices.ts). */preferences?:{consoleBackground:boolean;pinnedDeviceIds:string[];/** The account's Dashboard layout and the default layout (lib/server/dashboard-data.ts). */dashboard?:DashboardPreference}};
