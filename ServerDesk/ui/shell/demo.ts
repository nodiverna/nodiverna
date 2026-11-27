import type {AgentIntegrityEvent,OpenAlert,Server,ServerSnapshot,Sample,WindowsLicense} from '@/lib/types';
import {alertReadings,alertRule,defaultAlertSettings,evaluateAlertRules,type AlertIssue,type AlertRuleSettingsMap} from '@/lib/alert-rules';
import {deviceOsSupport,type EsuOverride} from '@/lib/os-support';
import {normalizeSoftwareName,normalizeSoftwareVersion,softwareMatches,softwareSearchTokens,type SoftwareItem} from '@/lib/software-inventory';
import type {DeviceSoftwareView,SoftwareFleetView} from '@/lib/server/devices/software';
import {demoAutostartSummary,demoDefender,demoHealthSignals2} from '@/ui/shell/demo-health-signals';
import {defenderJobKinds} from '@/lib/defender';
import {demoVerdict,demoVulnerabilityStatus} from '@/ui/shell/demo-vulnerabilities';
import {matchServerSoftware} from '@/lib/extensions';
import {demoDhcpAlerts,demoDhcpPlugin,demoPluginReleases} from '@/ui/shell/demo-dhcp';
import {demoDnsAlerts,demoDnsPlugin} from '@/ui/shell/demo-dns';
export {demoDhcpServerId,demoDhcpSnapshot} from '@/ui/shell/demo-dhcp';
export {demoAutostartFleet,demoAutostartView,demoDriverFleet,demoDriverView} from '@/ui/shell/demo-health-signals';
// Illustrative local fixtures only. The dashboard disables management actions
// in demo mode; these records are never persisted or submitted to an agent.
const capabilities=['refresh','scan-updates','install-gpu-driver','test-connection','start-service','stop-service','restart-service','set-service-startup','install-feature','remove-feature','set-network','set-dns','join-domain','leave-domain','rename-computer','set-pagefile','create-local-user','set-local-user','reset-local-password','delete-local-user','local-group-add','local-group-remove','restart-computer','shutdown-computer','install-updates','set-firewall-rule','add-firewall-rule','set-task','list-processes','list-sessions','list-connections','network-diagnostics','query-events','export-events','support-bundle','kill-process','message-session','disconnect-session','logoff-session','terminal','files','agent-update','runbook-step','drift','assistant-powershell'];
export function demoData(){
 const time=Date.now();const base:ServerSnapshot={protocolVersion:3,agentVersion:'3.0.1',mode:'ReadOnly',agentCapabilities:[...capabilities],hostname:'SRV-APP01',os:'Microsoft Windows Server 2025 Datacenter',build:'26100',manufacturer:'Microsoft Corporation',model:'Virtual Machine',domain:'contoso.local',cores:8,memoryGb:32,cpu:24,memory:62,uptimeSeconds:1267560,rebootPending:false,management:false,disks:[{name:'C:',label:'System',totalGb:128,freeGb:68},{name:'D:',label:'Daten',totalGb:512,freeGb:346}],services:[{name:'w32time',displayName:'Windows Time',status:'Running',startMode:'Auto'},{name:'WinRM',displayName:'Windows Remote Management',status:'Running',startMode:'Auto'},{name:'W3SVC',displayName:'World Wide Web Publishing Service',status:'Running',startMode:'Auto'},{name:'Spooler',displayName:'Print Spooler',status:'Stopped',startMode:'Manual'}],processes:[{name:'w3wp',pid:4812,memoryMb:486,cpuSeconds:224},{name:'svchost',pid:892,memoryMb:124,cpuSeconds:66},{name:'lsass',pid:680,memoryMb:82,cpuSeconds:180}],events:[{id:7040,level:'Warning',source:'Service Control Manager',message:'Der Starttyp des Dienstes wurde von automatisch zu manuell geändert.',at:new Date(time-720000).toISOString()},{id:10016,level:'Warning',source:'DistributedCOM',message:'Für die Anwendung wurden keine lokalen Aktivierungsberechtigungen erteilt.',at:new Date(time-2400000).toISOString()}],networks:[{name:'Ethernet',addresses:['10.10.1.12'],mac:'00-15-5D-01-A3-12',speedMbps:10000}],hotfixes:[{id:'KB5044284',installedOn:'2026-09-18'},{id:'KB5043080',installedOn:'2026-09-12'}],collectionErrors:[]};
 const specs=[['demo-app','SRV-APP01',24,62,2025,0],['demo-dc','SRV-DC01',8,35,2022,0],['demo-db','SRV-SQL01',71,84,2025,1],['demo-file','SRV-FILE01',12,48,2022,2]] as const;
 const at=(offset:number)=>new Date(time-offset).toISOString();
 const servers:Server[]=specs.map(([id,name,cpu,memory,year,warning],index)=>{
  const dc=id==='demo-dc',sql=id==='demo-db',file=id==='demo-file',app=id==='demo-app';
  const host=dc?4:sql?20:file?30:12,address=`10.10.1.${host}`,management=app||sql;
  const userSid=`S-1-5-21-100000001-200000002-${300000003+index}`;
  const services=base.services.filter(s=>app||s.name!=='W3SVC');
  if(dc)services.push({name:'DNS',displayName:'DNS Server',status:'Running',startMode:'Auto'},{name:'NTDS',displayName:'Active Directory Domain Services',status:'Running',startMode:'Auto'});
  if(sql)services.push({name:'MSSQLSERVER',displayName:'SQL Server (MSSQLSERVER)',status:'Running',startMode:'Auto'},{name:'SQLSERVERAGENT',displayName:'SQL Server Agent (MSSQLSERVER)',status:'Running',startMode:'Auto'});
  if(file)services.push({name:'LanmanServer',displayName:'Server',status:'Running',startMode:'Auto'});
  const firewallRules:NonNullable<ServerSnapshot['firewallRules']>=[
   {name:'RemoteDesktop-UserMode-In-TCP',displayName:'Remotedesktop – Benutzermodus (TCP eingehend)',enabled:true,direction:'Inbound',action:'Allow',protocol:'TCP',port:'3389',remoteAddress:'10.10.50.0/24'},
   {name:'WINRM-HTTP-In-TCP',displayName:'Windows-Remoteverwaltung (HTTP eingehend)',enabled:true,direction:'Inbound',action:'Allow',protocol:'TCP',port:'5985',remoteAddress:'LocalSubnet'},
   {name:'ServerDesk-Demo-Disabled',displayName:'Beispiel: deaktivierte Anwendung',enabled:false,direction:'Inbound',action:'Allow',protocol:'TCP',port:'8080',remoteAddress:'LocalSubnet'},
   {name:'ServerDesk-Demo-Application',displayName:app?'Beispiel: HTTPS-Anwendung':sql?'Beispiel: SQL-Anwendungszugriff':file?'Beispiel: SMB-Dateifreigaben':'Beispiel: DNS-Abfragen',enabled:true,direction:'Inbound',action:'Allow',protocol:dc?'UDP':'TCP',port:app?'443':sql?'1433':file?'445':'53',remoteAddress:sql?'10.10.1.12':'10.10.0.0/16'}
  ];
  const snapshot:ServerSnapshot={
   ...base,hostname:name,os:`Microsoft Windows Server ${year} Datacenter`,
   // Varied hardware, so the manufacturer logos and the neutral fallback (the Hyper-V machine) show.
   manufacturer:sql?'Dell Inc.':file?'HPE':dc?'Lenovo':base.manufacturer,model:sql?'PowerEdge R750':file?'ProLiant DL380 Gen10':dc?'ThinkSystem SR630':base.model,build:year===2022?'20348':'26100',domain:file?'WORKGROUP':'contoso.local',cpu,memory,rebootPending:warning===1,management,mode:management?'Management':'ReadOnly',protocolVersion:3,agentVersion:'3.0.1',agentCapabilities:[...capabilities],services,
   networks:[{...base.networks[0],addresses:[address],mac:`00-15-5D-01-A3-${host.toString(16).padStart(2,'0').toUpperCase()}`}],
   disks:sql?[base.disks[0],{name:'D:',label:'SQL-Daten',totalGb:512,freeGb:42}]:file?[base.disks[0],{name:'D:',label:'Freigaben',totalGb:2048,freeGb:864}]:base.disks,
   processes:sql?[{name:'sqlservr',pid:4216,memoryMb:20540,cpuSeconds:17280},...base.processes.filter(p=>p.name!=='w3wp')]:dc?[{name:'dns',pid:1432,memoryMb:96,cpuSeconds:380},...base.processes.filter(p=>p.name!=='w3wp')]:file?base.processes.filter(p=>p.name!=='w3wp'):base.processes,
   // One NVIDIA card with an older RTX driver: the GPU driver card shows it as outdated (ui/devices/hardware/gpu-driver-view.ts).
   ...(app?{gpus:[{id:'luid_0x00000000_0x0000d2a1_phys_0',name:'NVIDIA RTX A2000 12GB',vendor:'nvidia' as const,utilization:18,collectedAt:at(30000)}],gpuDetails:[{id:'luid_0x00000000_0x0000d2a1_phys_0',collectedAt:at(30000),driverVersion:'32.0.15.7342',vendorDriverVersion:'573.42',driverModel:'WDDM 3.2',vendorId:0x10de,deviceId:0x2571,dedicatedMemoryBytes:12884901888,sharedMemoryBytes:17179869184,sensorProvider:'nvidia-nvml' as const}]}:{}),
   features:[
    {name:'NET-Framework-45-Core',displayName:'.NET Framework 4.8',installed:true,featureType:'Feature'},
    {name:'Web-Server',displayName:'Webserver (IIS)',installed:app,featureType:'Role',parent:null,subFeatures:['Web-WebServer'],depth:1},
    {name:'Web-WebServer',displayName:'Webserverdienste',installed:app,featureType:'Role Service',parent:'Web-Server',subFeatures:['Web-Static-Content','Web-WebSockets'],depth:2},
    {name:'Web-Static-Content',displayName:'Statischer Inhalt',installed:app,featureType:'Role Service',parent:'Web-WebServer',subFeatures:[],depth:3},
    {name:'Web-WebSockets',displayName:'WebSocket-Protokoll',installed:false,featureType:'Role Service',parent:'Web-WebServer',subFeatures:[],depth:3},
    {name:'FileAndStorage-Services',displayName:'Datei- und Speicherdienste',installed:true,featureType:'Role',parent:null,subFeatures:['File-Services'],depth:1},
    {name:'File-Services',displayName:'Datei- und iSCSI-Dienste',installed:file,featureType:'Role Service',parent:'FileAndStorage-Services',subFeatures:['FS-FileServer'],depth:2},
    {name:'FS-FileServer',displayName:'Dateiserver',installed:file,featureType:'Role Service',parent:'File-Services',subFeatures:[],depth:3},
    {name:'DNS',displayName:'DNS-Server',installed:dc,featureType:'Role'},
    {name:'DHCP',displayName:'DHCP-Server',installed:dc,featureType:'Role'},
    {name:'AD-Domain-Services',displayName:'Active Directory-Domänendienste',installed:dc,featureType:'Role'},
    {name:'Windows-Server-Backup',displayName:'Windows Server-Sicherung',installed:file,featureType:'Feature'},
    {name:'Hyper-V',displayName:'Hyper-V',installed:false,featureType:'Role'}
   ],
   localUsers:dc?[]:[
    {name:'ServerAdmin',sid:userSid+'-1001',enabled:true,fullName:'Lokaler Serveradministrator',description:'Beispiel: lokales Notfallkonto',passwordExpires:false,lastLogon:at(86400000)},
    {name:'svc_inventory',sid:userSid+'-1002',enabled:true,fullName:'Inventardienst',description:'Beispiel: eingeschränktes Dienstkonto',passwordExpires:true,lastLogon:at(3600000)},
    {name:'Guest',sid:userSid+'-501',enabled:false,fullName:'',description:'Integriertes Gastkonto',passwordExpires:false,lastLogon:''}
   ],
   localGroups:dc?[]:[
    {name:'Administratoren',sid:'S-1-5-32-544',members:[`${name}\\ServerAdmin`,...(file?[]:['CONTOSO\\Domain Admins'])]},
    {name:'Benutzer',sid:'S-1-5-32-545',members:[`${name}\\svc_inventory`]},
    {name:'Remotedesktopbenutzer',sid:'S-1-5-32-555',members:file?[]:['CONTOSO\\Server Operators']}
   ],
   networkConfig:[{interfaceIndex:6,alias:'Ethernet',dhcp:file,addresses:[{address,prefixLength:24}],gateway:['10.10.1.1'],dns:dc?['10.10.1.4']:file?['10.10.1.1']:['10.10.1.4','10.10.1.5'],status:'Up'}],
   pagefile:{automatic:!sql,files:[{name:'C:\\pagefile.sys',initialMb:sql?8192:0,maximumMb:sql?16384:0,allocatedMb:sql?8192:dc?2048:4096,currentUsageMb:sql?6024:512,peakUsageMb:sql?7440:890}]},
   security:{domainJoined:!file,domainRole:dc?5:file?2:3,rdpEnabled:true,firewall:[{name:'Domain',enabled:true},{name:'Private',enabled:true},{name:'Public',enabled:true}],defender:{available:true,enabled:true,signatureAt:at(file?9*86400000:3600000),realTimeProtection:true},lastBoot:at(base.uptimeSeconds*1000)},
   firewallRules,
   tasks:[
    {name:'Beispiel – tägliches Inventar',path:'\\Contoso\\',state:'Ready',lastRun:at(3600000),nextRun:at(-23*3600000),lastResult:0},
    {name:file?'Beispiel – Dateisicherung':sql?'Beispiel – Datenbanksicherung':'Beispiel – Protokollbereinigung',path:'\\Contoso\\',state:'Ready',lastRun:at(8*3600000),nextRun:at(-16*3600000),lastResult:0},
    {name:'Beispiel – alte Wartungsaufgabe',path:'\\Contoso\\',state:'Disabled',lastRun:at(7*86400000),nextRun:'',lastResult:0}
   ],
   updates:{checkedAt:at(3600000),pendingCount:sql?2:app?1:0,items:sql?[
    {id:'11111111-1111-4111-8111-111111111111',title:'Beispiel: kumulatives Sicherheitsupdate für Windows Server 2025',kb:'Demodatensatz',severity:'Critical',rebootRequired:true},
    {id:'22222222-2222-4222-8222-222222222222',title:'Beispiel: Sicherheitsupdate für .NET Framework',kb:'Demodatensatz',severity:'Important',rebootRequired:true}
   ]:app?[{id:'33333333-3333-4333-8333-333333333333',title:'Beispiel: Sicherheitsupdate für .NET Framework',kb:'Demodatensatz',severity:'Important',rebootRequired:false}]:[]},
   performance:{diskReadBytesSec:(sql?22:dc?0.2:file?6:1.4)*1048576,diskWriteBytesSec:(sql?18:dc?0.1:file?2:0.6)*1048576,networkBytesSec:(sql?6:dc?0.3:file?24:4)*1048576,diskLatencyMs:sql?72:dc?2.8:file?9.4:11,processorQueue:sql?9:dc?0:1,pagefilePercent:sql?73.5:12.5},
   // English agent texts as the agent sends them: a reason the catalog knows (ui/base/agent-reasons.ts) and one it does not, so both forms show.
   collectionErrors:dc?['The last update inventory could not be read.']:file?['Software inventory: the Windows Installer provider skipped 2 products with an invalid version.']:[]
  };
  // Sample description and own tags (sample devices belong to no group, so nothing is inherited).
  const description=app?'Web front end of the order portal.\nContact: IT operations, room 2.14':sql?'SQL Server for accounting and the ERP system.':dc?'Domain controller of the head office.':'';
  const tags=(app?[['Environment','Production'],['Owner','IT operations'],['Patch window','Tuesday']]:sql?[['Environment','Production'],['Backup','Daily'],['Owner','Finance'],['Patch window','Sunday']]:dc?[['Environment','Production'],['Critical','']]:[['Environment','Test']])
   .map(([tagName,value])=>({name:tagName,value,inherited:false,groupId:null}));
  Object.assign(snapshot,demoHealth(id,time),demoHealthSignals2(id,time),demoDefender(id,time),{windowsLicense:demoWindowsLicense(id,time)});
  // Agent 4.15.0 on every sample device except SRV-DC01, which shows the "update the agent" state.
  if(!dc)snapshot.agentCapabilities=[...snapshot.agentCapabilities,'defender-status',...defenderJobKinds];
  // SRV-FILE01: Defender is passive next to another antivirus, so real-time protection is off.
  if(file&&snapshot.security)snapshot.security.defender.realTimeProtection=false;
  // SRV-FILE01 was renamed once, so the "Previously" hint and the search by an old name show in demo mode.
  // SRV-DC01 runs the DHCP plugin (ui/shell/demo-dhcp.ts) and the DNS plugin (ui/shell/demo-dns.ts).
  if(dc)Object.assign(snapshot,{agentCapabilities:[...snapshot.agentCapabilities,'plugin-host'],plugins:[demoDhcpPlugin,demoDnsPlugin]});
  const device:Server={id,name,createdAt:time-86400000*30,lastSeen:time-(warning===2?900000:20000),revoked:0,management:management?1:0,snapshot,description,nameSource:'hostname',previousNames:file?['SRV-FS01']:[],tags,autostart:demoAutostartSummary(id,time),...demoServerSoftware(id)};
  // Sample devices have no server: their support status and issues come from the default rules, evaluated here.
  const osSupport=deviceOsSupport(device,demoEsu(time),defaultAlertSettings(),time);
  // SRV-DC01 adds its DHCP data for the DHCP rules (Wi-Fi Guests at 93 %); the row never carries them.
  // SRV-FILE01 adds one integrity event: the broker started its stopped worker 40 minutes ago (agent-stopped warning).
  const evaluated={...device,osSupport,...(dc?{dhcpAlerts:demoDhcpAlerts(time),dnsAlerts:demoDnsAlerts(time)}:{}),...(file?{agentIntegrity:demoAgentIntegrity(time)}:{})};
  const settings=defaultAlertSettings(),issues=evaluateAlertRules(evaluated,settings,time);
  return {...device,osSupport,issues,alerts:demoAlerts(evaluated,issues,settings,time)};
 });
 const samples:Sample[]=servers.flatMap(s=>Array.from({length:31},(_,i)=>({serverId:s.id,at:(s.lastSeen??time)-(30-i)*60000,cpu:Math.round(Math.max(2,Math.min(98,(s.snapshot?.cpu??0)+Math.sin(i*1.6)*7+Math.cos(i*.5)*5))),memory:Math.round(Math.max(2,(s.snapshot?.memory??0)+Math.sin(i*.4)*3))})));
 return {servers,samples,pluginReleases:demoPluginReleases(time)};
}

/** The stored integrity events of SRV-FILE01: the watchdog started the stopped worker 40 minutes ago (lib/server/agent/agent-integrity.ts). */
function demoAgentIntegrity(time:number):{events:AgentIntegrityEvent[]}{
 return {events:[{id:'demo-integrity-1',kind:'service-restarted',service:'worker',target:null,startType:null,reason:null,user:null,finding:null,repaired:null,occurredAt:time-40*60_000,receivedAt:time-40*60_000}]};
}

// ---- Health signals of the sample devices (docs/device-health-signals.md) ----
const day=86400000;
/** ESU dates of the sample devices: SRV-SQL01 runs Server 2016 with ESU for 120 more days, SRV-FILE01 had ESU until 2026-10-13. */
function demoEsu(time:number):EsuOverride[]{
 return [{scopeType:'device',scopeId:'demo-db',until:new Date(time+120*day).toISOString().slice(0,10),updatedAt:time},{scopeType:'device',scopeId:'demo-file',until:'2026-10-13',updatedAt:time}];
}
/**
 * The Windows activation of the sample devices (agent 4.22.0): SRV-SQL01 is an activated evaluation with 47 days left,
 * SRV-FILE01 runs in notification mode with a retail key, SRV-APP01 is a KMS client whose activation runs 170 more days,
 * SRV-DC01 is activated with an OEM key.
 */
function demoWindowsLicense(id:string,time:number):WindowsLicense{
 const collectedAt=new Date(time-20*60_000).toISOString(),ahead=(days:number)=>new Date(time+days*day).toISOString();
 if(id==='demo-db')return {available:true,collectedAt,status:'licensed',channel:'evaluation',expiresAt:ahead(47),evaluationEndsAt:null};
 if(id==='demo-file')return {available:true,collectedAt,status:'notification',channel:'retail',expiresAt:null,evaluationEndsAt:null};
 if(id==='demo-app')return {available:true,collectedAt,status:'licensed',channel:'volume-kms',expiresAt:ahead(170),evaluationEndsAt:null};
 return {available:true,collectedAt,status:'licensed',channel:'oem',expiresAt:null,evaluationEndsAt:null};
}
type DemoProtector='tpm'|'numerical-password'|'tpm-pin';
const demoVolume=(drive:string,volumeType:'os'|'fixed',conversion:'encrypted'|'encrypting'|'decrypted',protection:'on'|'off'|'suspended',protectors:DemoProtector[],percent:number|null=null,suspendedSince:string|null=null)=>({drive,volumeType,conversion,percent:percent??(conversion==='encrypted'?100:conversion==='decrypted'?0:null),protection,method:conversion==='decrypted'?'none' as const:'xts-aes-256' as const,protectors,suspendedSince});
// One device per support status (supported, ending with ESU, ended with ESU, unknown), crashes and every BitLocker state.
function demoHealth(id:string,time:number):Partial<ServerSnapshot>{
 const at=(offset:number)=>new Date(time-offset).toISOString(),inventory={collectedAt:at(600000),windowDays:30 as const,complete:true,truncated:false};
 const parameters=['0x00000000c0000005','0xfffff80410001234','0xffffd00012345678','0x0000000000000000'];
 const vjoy=(days:number,index:number)=>({id:'demo-crash-'+index,kind:'bugcheck' as const,at:at(days*day),stopCode:0x3B,parameters,driver:{name:'vjoy.sys',version:'2.1.9.1',manufacturer:'Contoso Devices'},source:'event+minidump' as const,dumpFile:'1020'+index+'6-12000-01.dmp',dumpStatus:'parsed' as const,detail:null});
 if(id==='demo-app')return {osInfo:{editionId:'ServerDatacenter',installationType:'Server',displayVersion:'24H2',ubr:2314,productName:'Windows Server 2025 Datacenter',currentBuild:'26100'},
  crashes:[vjoy(1,1),vjoy(6,2),vjoy(13,3)],crashInventory:inventory,
  bitlocker:{available:true,collectedAt:at(600000),volumes:[demoVolume('C:','os','encrypted','on',['tpm','numerical-password']),demoVolume('D:','fixed','encrypted','on',['numerical-password'])]}};
 if(id==='demo-db')return {os:'Microsoft Windows Server 2016 Datacenter',build:'14393',osInfo:{editionId:'ServerDatacenter',installationType:'Server',displayVersion:null,ubr:7428,productName:'Windows Server 2016 Datacenter',currentBuild:'14393'},
  crashes:[{id:'demo-crash-4',kind:'unexpected-shutdown',at:at(20*day),stopCode:null,parameters:null,driver:null,source:'event',dumpFile:null,dumpStatus:'none',detail:null}],crashInventory:inventory,
  bitlocker:{available:true,collectedAt:at(600000),volumes:[demoVolume('C:','os','encrypted','suspended',['tpm','numerical-password'],100,at(2*day)),demoVolume('D:','fixed','encrypted','on',['tpm'])]}};
 if(id==='demo-file')return {os:'Microsoft Windows 10 Enterprise',build:'19045',osInfo:{editionId:'Enterprise',installationType:'Client',displayVersion:'22H2',ubr:6456,productName:'Windows 10 Enterprise',currentBuild:'19045'},
  crashes:[],crashInventory:inventory,
  bitlocker:{available:true,collectedAt:at(600000),volumes:[demoVolume('C:','os','decrypted','off',[]),demoVolume('D:','fixed','encrypting','on',['tpm-pin'],42)]}};
 return {os:'Microsoft Windows Server 2012 R2 Datacenter',build:'9600',osInfo:{editionId:'ServerDatacenter',installationType:'Server',displayVersion:null,ubr:21620,productName:'Windows Server 2012 R2 Datacenter',currentBuild:'9600'},
  crashes:[],crashInventory:inventory,bitlocker:{available:false,reason:'not-supported',collectedAt:at(600000),volumes:[]}};
}
type DemoProgram=[name:string,version:string,publisher:string|null,installDate:string|null];
const demoPrograms:Record<string,DemoProgram[]>={
 common:[['Google Chrome','120.0.6099.130','Google LLC','2026-01-15'],['7-Zip 23.01 (x64)','23.01','Igor Pavlov','2025-11-02'],['Microsoft Edge','130.0.2849.56','Microsoft Corporation','2026-10-01'],['Notepad++ (64-bit x64)','8.6.2','Notepad++ Team',null]],
 'demo-app':[['Microsoft .NET Runtime - 8.0.10 (x64)','8.0.10','Microsoft Corporation','2026-09-12'],['IIS URL Rewrite Module 2','7.2.1993','Microsoft Corporation','2025-03-04']],
 'demo-db':[['Microsoft SQL Server 2022 (64-bit)','16.0.4135.4','Microsoft Corporation','2026-02-20'],['Google Chrome','109.0.5414.120','Google LLC','2023-01-25']],
 'demo-dc':[['Microsoft .NET Runtime - 8.0.10 (x64)','8.0.10','Microsoft Corporation','2026-09-12']],
 'demo-file':[['Veeam Agent for Microsoft Windows','6.1.2.134','Veeam Software Group GmbH','2026-06-30']],
};
function demoItems(serverId:string):SoftwareItem[]{
 const own=demoPrograms[serverId]??[],chromeOverride=own.some(([name])=>name==='Google Chrome');
 return [...demoPrograms.common.filter(([name])=>!(chromeOverride&&name==='Google Chrome')),...own].map(([name,version,publisher,installDate],index)=>({key:`{DEMO-${serverId}-${index}}`,name,version,publisher,installDate,architecture:index%2===0?'x64':'x86',scope:'machine'}));
}
/** The known server products of a sample device, from its sample programs (the console reads them from device_software). */
function demoServerSoftware(serverId:string):Pick<Server,'serverSoftware'>{
 const matches=matchServerSoftware(demoItems(serverId).map(item=>({name:item.name,version:item.version,normalizedName:normalizeSoftwareName(item.name,item.version),normalizedVersion:normalizeSoftwareVersion(item.version)})));
 return matches.length?{serverSoftware:matches}:{};
}
/** The software area of a sample device, served in the browser, with the verdicts of the sample vulnerability data (ui/shell/demo-vulnerabilities.ts). */
export function demoSoftwareView(serverId:string,time:number):DeviceSoftwareView{
 const items=demoItems(serverId).map(item=>{const normalizedName=normalizeSoftwareName(item.name,item.version),normalizedVersion=normalizeSoftwareVersion(item.version);return {...item,firstSeen:time-20*day,normalizedName,normalizedVersion,verdict:demoVerdict(normalizedName,normalizedVersion,item.publisher)};});
 return {state:{checksum:'0'.repeat(64),reportedAt:time-10*60000,count:items.length,truncated:false},items,
  changes:[{id:2,at:time-2*day,change:'updated',name:'Microsoft Edge',versionFrom:'129.0.2792.89',versionTo:'130.0.2849.56',publisher:'Microsoft Corporation',architecture:'x64',scope:'machine'},{id:1,at:time-9*day,change:'installed',name:'Notepad++ (64-bit x64)',versionFrom:null,versionTo:'8.6.2',publisher:'Notepad++ Team',architecture:'x64',scope:'machine'}],
  vulnerabilities:demoVulnerabilityStatus(time)};
}
/** The software tab over sample devices, grouped by normalized name and version like GET /api/software. */
export function demoSoftwareFleet(deviceIds:readonly string[],query:string,time:number=Date.now(),vulnerableOnly=false):SoftwareFleetView{
 const tokens=softwareSearchTokens(query),groups=new Map<string,{name:string;publisher:string|null;version:string|null;normalizedName:string;normalizedVersion:string|null;deviceIds:Set<string>}>();
 for(const id of deviceIds)for(const item of demoItems(id)){
  if(tokens.length&&!softwareMatches(item,tokens))continue;
  const normalizedName=normalizeSoftwareName(item.name,item.version),normalizedVersion=normalizeSoftwareVersion(item.version),key=JSON.stringify([normalizedName,normalizedVersion]);
  const group=groups.get(key)??{name:item.name,publisher:item.publisher,version:item.version,normalizedName,normalizedVersion,deviceIds:new Set<string>()};
  group.deviceIds.add(id);groups.set(key,group);
 }
 const all=[...groups.values()].map(group=>({...group,deviceCount:group.deviceIds.size,deviceIds:[...group.deviceIds].sort(),verdict:demoVerdict(group.normalizedName,group.normalizedVersion,group.publisher)})).sort((a,b)=>b.deviceCount-a.deviceCount||a.name.localeCompare(b.name));
 const vulnerableRows=all.filter(row=>row.verdict.status==='vulnerable').length,rows=vulnerableOnly?all.filter(row=>row.verdict.status==='vulnerable'):all;
 return {rows,total:rows.length,truncated:false,vulnerabilities:{...demoVulnerabilityStatus(time),vulnerableRows}};
}

/**
 * The open alarms of a sample device: every warning or critical issue is an
 * alarm that started 25 minutes ago, not acknowledged and not muted. The state
 * actions are blocked in demo mode.
 */
function demoAlerts(device:Server,issues:readonly AlertIssue[],settings:AlertRuleSettingsMap,time:number):OpenAlert[]{
 const readings=new Map(alertReadings(device,time).map(reading=>[reading.ruleId+'/'+reading.key,reading.value]));
 const startedAt=time-25*60000;
 return issues.filter(issue=>issue.level!=='info').map(issue=>{
  const rule=alertRule(issue.ruleId),level=issue.level as 'warning'|'critical';
  return {id:'demo-alarm-'+device.id+'-'+issue.key,ruleId:issue.ruleId,key:issue.key,level,peakLevel:level,peakValue:rule.kind!=='boolean'?readings.get(issue.ruleId+'/'+issue.key)??null:null,
   threshold:rule.kind==='threshold'?settings[rule.id][level]:rule.kind==='limit'?settings[rule.id].warning:null,params:issue.params,startedAt,openedAt:startedAt,acknowledged:null,muted:null};
 });
}
