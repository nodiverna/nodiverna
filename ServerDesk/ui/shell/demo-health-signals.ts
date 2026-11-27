// Health signals of agent 4.11.0 for the sample devices (docs/device-health-signals.md):
// drivers and problem devices, reliability, disk and battery health,
// certificates and autostart, plus the client-side views of the device areas
// and scope tabs that call an API for real devices. Illustrative only; nothing
// is persisted or sent to an agent, and the confirm actions are blocked.
import type {AutostartSummary,BatteryState,CertificateInventory,DiskHealth,DriverHealth,Reliability,ServerSnapshot} from '@/lib/types';
import type {DeviceDriverView,DriverFleetView} from '@/lib/server/devices/drivers';
import type {AutostartEntry,AutostartFleetView,DeviceAutostartView} from '@/lib/server/devices/autostart';
import {driverMatches,driverName,driverSearchTokens,type DriverItem} from '@/lib/driver-inventory';
import {autostartMatches,autostartSearchTokens,autostartSuspicious,type AutostartItem} from '@/lib/autostart-inventory';

const day=86400000,hour=3600000;
/** A stable hex string of the given length for sample IDs (not a hash). */
function hex(seed:string,length:number):string{
 let state=2166136261,out='';
 while(out.length<length){for(const char of seed+out.length)state=Math.imul(state^char.charCodeAt(0),16777619)>>>0;out+=state.toString(16).padStart(8,'0');}
 return out.slice(0,length);
}
const iso=(time:number)=>new Date(time).toISOString();

// ---- Drivers ----
type DemoDriver=[deviceName:string,deviceClass:string,infName:string,file:string|null,provider:string,version:string,date:string,signed:boolean];
const commonDrivers:DemoDriver[]=[
 ['Microsoft Hyper-V Network Adapter','Net','netvsc.inf','netvsc.sys','Microsoft','10.0.26100.1','2006-06-21',true],
 ['Microsoft Hyper-V SCSI Controller','SCSIAdapter','storvsc.inf','storvsc.sys','Microsoft','10.0.26100.1','2006-06-21',true],
 ['Standard SATA AHCI Controller','HDC','mshdc.inf','storahci.sys','Microsoft','10.0.26100.2314','2006-06-21',true],
 ['Intel(R) Ethernet Connection I219-LM','Net','oem7.inf','e1d68x64.sys','Intel','12.19.2.45','2023-04-12',true],
];
const ownDrivers:Record<string,DemoDriver[]>={
 'demo-app':[['vJoy Device','HIDClass','oem42.inf','vjoy.sys','Contoso Devices','2.1.9.1','2019-11-20',false],['NVIDIA GeForce RTX A2000','Display','oem12.inf','nvlddmkm.sys','NVIDIA','31.0.15.3623','2023-06-12',true]],
 'demo-db':[['Broadcom NetXtreme Gigabit Ethernet','Net','oem3.inf','b57nd60a.sys','Broadcom','214.0.0.6','2015-03-10',true]],
};
function demoDriverItems(serverId:string):DriverItem[]{
 return [...commonDrivers,...(ownDrivers[serverId]??[])].map(([deviceName,deviceClass,infName,file,provider,version,date,signed])=>({key:hex(serverId+deviceName,16),deviceName,deviceClass,infName,file,service:file?file.replace(/\.sys$/,''):null,provider,version,date,signed,signer:signed?'Microsoft Windows':null}));
}
function demoDriverHealth(serverId:string,time:number):DriverHealth{
 const items=demoDriverItems(serverId),unsigned=items.filter(item=>item.signed===false);
 const problems=serverId==='demo-app'?[
  {key:hex('problem-28',16),name:'PCI Data Acquisition and Signal Processing Controller',class:null,code:28,manufacturer:null},
  {key:hex('problem-43',16),name:'NVIDIA GeForce RTX A2000',class:'Display',code:43,manufacturer:'NVIDIA'},
 ]:[];
 return {collectedAt:iso(time-10*60000),checksum:hex('drivers'+serverId,64),count:items.length,truncated:false,unsignedCount:unsigned.length,
  unsigned:unsigned.map(item=>({key:item.key,deviceName:item.deviceName,infName:item.infName,file:item.file,provider:item.provider,version:item.version})),problems,problemsTruncated:false};
}
/** The Drivers area of a sample device, served in the browser. */
export function demoDriverView(serverId:string,time:number):DeviceDriverView{
 const items=demoDriverItems(serverId).sort((a,b)=>a.deviceName.localeCompare(b.deviceName));
 return {state:{checksum:hex('drivers'+serverId,64),reportedAt:time-10*60000,count:items.length,truncated:false},items};
}
/** The Drivers tab over sample devices, grouped like GET /api/drivers. */
export function demoDriverFleet(deviceIds:readonly string[],query:string):DriverFleetView{
 const tokens=driverSearchTokens(query),groups=new Map<string,{item:DriverItem;deviceIds:Set<string>}>();
 for(const id of deviceIds)for(const item of demoDriverItems(id)){
  if(tokens.length&&!driverMatches(item,tokens))continue;
  const key=JSON.stringify([driverName(item),item.version,item.provider]),group=groups.get(key)??{item,deviceIds:new Set<string>()};
  group.deviceIds.add(id);groups.set(key,group);
 }
 const rows=[...groups.values()].map(({item,deviceIds:ids})=>({driver:driverName(item),version:item.version,provider:item.provider,date:item.date,signed:item.signed,deviceClass:item.deviceClass,deviceCount:ids.size,deviceIds:[...ids].sort()}))
  .sort((a,b)=>b.deviceCount-a.deviceCount||a.driver.localeCompare(b.driver));
 return {rows,total:rows.length,truncated:false};
}

// ---- Reliability ----
function demoReliability(serverId:string,time:number):Reliability{
 const collectedAt=iso(time-10*60000);
 if(serverId==='demo-dc')return {collectedAt,windowDays:30,stability:{available:false,reason:'collection-disabled'},events:[{at:iso(time-4*day),kind:'hang',program:'mmc.exe',version:'10.0.20348.1',module:null,moduleVersion:null}],truncated:false};
 const falling=serverId==='demo-app';
 const days=Array.from({length:30},(_,index)=>{const at=time-(29-index)*day;return {day:iso(at).slice(0,10),index:falling?Math.round(Math.max(3.8,9.6-Math.max(0,index-14)*0.4)*10)/10:Math.round((9.2+Math.sin(index/3)*0.5)*10)/10};});
 if(falling)days[29].index=3.8;
 const outlook=(offset:number)=>({at:iso(time-offset),kind:'crash' as const,program:'OUTLOOK.EXE',version:'16.0.17928.20114',module:'mso40uiwin32client.dll',moduleVersion:'16.0.17928.20114'});
 const events:Reliability['events']=falling?[outlook(3*hour),outlook(1*day),outlook(2*day+hour),outlook(4*day),outlook(6*day),
  {at:iso(time-5*day),kind:'hang' as const,program:'Teams.exe',version:'24215.1007.3082.1590',module:null,moduleVersion:null},
  {at:iso(time-9*day),kind:'install-failure' as const,program:'Contoso Monitoring Agent',version:null,module:null,moduleVersion:null},
  {at:iso(time-12*day),kind:'crash' as const,program:'w3wp.exe',version:'10.0.26100.1',module:'clr.dll',moduleVersion:'4.8.9277.0'}]
  :serverId==='demo-db'?[{at:iso(time-2*day),kind:'crash' as const,program:'ssms.exe',version:'20.2.30.0',module:'KERNELBASE.dll',moduleVersion:'10.0.14393.7428'}]:[];
 return {collectedAt,windowDays:30,stability:{available:true,current:days[29].index,days},events,truncated:false};
}

// ---- Disk and battery health ----
function demoDiskHealth(serverId:string,time:number):DiskHealth{
 const collectedAt=iso(time-10*60000);
 const ssd=(id:string,model:string,letters:string[],wear:number,hours:number)=>({id,number:Number(id),model,busType:'NVMe',mediaType:'ssd' as const,health:'healthy' as const,operationalStatus:['ok' as const],driveLetters:letters,countersAvailable:true,wearPercent:wear,temperatureC:41,temperatureMaxC:68,readErrorsUncorrected:0,powerOnHours:hours});
 if(serverId==='demo-app')return {collectedAt,disks:[ssd('0','Samsung SSD 970 EVO Plus 1TB',['C:'],86,31240),
  {id:'1',number:1,model:'SanDisk Ultra USB 3.0',busType:'USB',mediaType:'unspecified',health:'unknown',operationalStatus:['ok'],driveLetters:['E:'],countersAvailable:false,wearPercent:null,temperatureC:null,temperatureMaxC:null,readErrorsUncorrected:null,powerOnHours:null}],
  events:{windowDays:30,items:[],counts:{},truncated:false}};
 if(serverId==='demo-db')return {collectedAt,disks:[ssd('0','Micron 7450 PRO 960GB',['C:'],12,8810),
  {id:'1',number:1,model:'WDC WD40EFRX-68N32N0',busType:'SATA',mediaType:'hdd',health:'healthy',operationalStatus:['ok'],driveLetters:['D:'],countersAvailable:true,wearPercent:null,temperatureC:44,temperatureMaxC:57,readErrorsUncorrected:3,powerOnHours:41020}],
  events:{windowDays:30,items:[{at:iso(time-1*day),source:'disk',eventId:7,disk:1,volume:null},{at:iso(time-3*day),source:'disk',eventId:7,disk:1,volume:null},{at:iso(time-8*day),source:'disk',eventId:7,disk:1,volume:null}],counts:{'1':3},truncated:false}};
 return {collectedAt,disks:[ssd('0',serverId==='demo-file'?'KIOXIA KBG40ZNS512G':'Samsung SSD 980 PRO 500GB',['C:'],serverId==='demo-file'?23:5,serverId==='demo-file'?6120:2210)],events:{windowDays:30,items:[],counts:{},truncated:false}};
}
function demoBattery(serverId:string,time:number):BatteryState{
 const collectedAt=iso(time-10*60000);
 if(serverId==='demo-file')return {collectedAt,present:true,batteries:[{id:0,name:'DELL 7FHHV',designCapacityMWh:57000,fullChargeCapacityMWh:30780,healthPercent:54,cycleCount:412}]};
 return {collectedAt,present:false,reason:'no-battery',batteries:[]};
}

// ---- Certificates ----
function demoCertificates(serverId:string,time:number):CertificateInventory{
 const collectedAt=iso(time-10*60000);
 const cert=(seed:string,subject:string,issuer:string,from:number,until:number,stores:CertificateInventory['items'][number]['stores'],hasPrivateKey:boolean,bindings:CertificateInventory['items'][number]['bindings'],sans:string[]=[])=>({thumbprint:hex(serverId+seed,40).toUpperCase(),stores,subject,sans,issuer,notBefore:iso(time+from),notAfter:iso(time+until),hasPrivateKey,selfSigned:subject===issuer,bindings});
 const host=serverId==='demo-app'?'srv-app01':serverId==='demo-db'?'srv-sql01':serverId==='demo-dc'?'srv-dc01':'srv-file01';
 const own=cert('web','CN='+host+'.contoso.local','CN=Contoso Issuing CA 01',-200*day,165*day,['My'],true,[],[host+'.contoso.local']);
 if(serverId!=='demo-app')return {collectedAt,items:[own],truncated:false};
 return {collectedAt,truncated:false,items:[
  cert('intranet','CN=intranet.contoso.local','CN=Contoso Issuing CA 01',-400*day,-20*day,['My'],true,[],['intranet.contoso.local']),
  cert('old-ca','CN=Contoso Old Intermediate CA','CN=Contoso Root CA',-3650*day,-60*day,['My'],false,[]),
  cert('portal','CN=portal.contoso.com','CN=R11, O=Let\'s Encrypt, C=US',-87*day,3*day,['My','WebHosting'],true,[{type:'https',endpoint:'0.0.0.0:443'}],['portal.contoso.com','www.portal.contoso.com']),
  cert('rdp','CN='+host+'.contoso.local','CN='+host+'.contoso.local',-168*day,12*day,['Remote Desktop'],true,[{type:'rdp',endpoint:'RDP-Tcp'}]),
  own,
 ]};
}

// ---- Autostart ----
type DemoAutostart={category:AutostartItem['category'];scope:AutostartItem['scope'];location:string;name:string;command:string;target:string|null;signature:AutostartItem['signature'];signer:string|null;publisher:string|null;microsoft:boolean;userPath:boolean;state:'baseline'|'confirmed'|'new';age:number};
const run='HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run';
const commonAutostart:DemoAutostart[]=[
 {category:'run',scope:'machine',location:run,name:'SecurityHealth',command:'%windir%\\system32\\SecurityHealthSystray.exe',target:'C:\\Windows\\system32\\SecurityHealthSystray.exe',signature:'valid',signer:'Microsoft Windows',publisher:'Microsoft Corporation',microsoft:true,userPath:false,state:'baseline',age:30},
 {category:'winlogon',scope:'machine',location:'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon',name:'Userinit',command:'C:\\Windows\\system32\\userinit.exe,',target:'C:\\Windows\\system32\\userinit.exe',signature:'valid',signer:'Microsoft Windows',publisher:'Microsoft Corporation',microsoft:true,userPath:false,state:'baseline',age:30},
 {category:'service',scope:'machine',location:'HKLM\\SYSTEM\\CurrentControlSet\\Services\\ServerDeskAgent',name:'ServerDeskAgent',command:'"C:\\Program Files\\ServerDesk\\ServerDesk.Agent.exe" --broker',target:'C:\\Program Files\\ServerDesk\\ServerDesk.Agent.exe',signature:'valid',signer:'Nodiverna',publisher:'Nodiverna',microsoft:false,userPath:false,state:'baseline',age:30},
];
const ownAutostart:Record<string,DemoAutostart[]>={
 'demo-app':[
  {category:'service',scope:'machine',location:'HKLM\\SYSTEM\\CurrentControlSet\\Services\\ContosoBackup',name:'ContosoBackup',command:'"C:\\Program Files\\Contoso\\Backup\\agent.exe" --apikey [redacted]',target:'C:\\Program Files\\Contoso\\Backup\\agent.exe',signature:'valid',signer:'Contoso Ltd',publisher:'Contoso Ltd',microsoft:false,userPath:false,state:'confirmed',age:12},
  {category:'task',scope:'machine',location:'\\Vendor\\',name:'Vendor Update',command:'"C:\\Program Files\\Vendor\\update.exe" /silent',target:'C:\\Program Files\\Vendor\\update.exe',signature:'valid',signer:'Vendor Inc',publisher:'Vendor Inc',microsoft:false,userPath:false,state:'new',age:2},
  {category:'run',scope:'user',location:'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run',name:'Updater',command:'C:\\Users\\…\\AppData\\Local\\Temp\\upd.exe --token=[redacted]',target:'C:\\Users\\…\\AppData\\Local\\Temp\\upd.exe',signature:'unsigned',signer:null,publisher:null,microsoft:false,userPath:true,state:'new',age:1},
 ],
 'demo-db':[{category:'service',scope:'machine',location:'HKLM\\SYSTEM\\CurrentControlSet\\Services\\SQLTELEMETRY',name:'SQLTELEMETRY',command:'"C:\\Program Files\\Microsoft SQL Server\\MSSQL16.MSSQLSERVER\\MSSQL\\Binn\\sqlceip.exe" -Service',target:'C:\\Program Files\\Microsoft SQL Server\\MSSQL16.MSSQLSERVER\\MSSQL\\Binn\\sqlceip.exe',signature:'valid',signer:'Microsoft Corporation',publisher:'Microsoft Corporation',microsoft:false,userPath:false,state:'baseline',age:30}],
};
function demoAutostartEntries(serverId:string,time:number):AutostartEntry[]{
 return [...commonAutostart,...(ownAutostart[serverId]??[])].map(({state,age,...item})=>{
  const entry:AutostartItem={id:hex(serverId+item.category+item.name,64),...item};
  const baseline=state==='baseline',acknowledgedAt=state==='confirmed'?time-3*day:null;
  return {...entry,firstSeen:time-age*day,baseline,acknowledgedAt,acknowledgedBy:state==='confirmed'?'admin@contoso.local':null,isNew:state==='new',suspicious:autostartSuspicious(entry)};
 });
}
/** The Autostart area of a sample device; confirming is blocked for sample devices. */
export function demoAutostartView(serverId:string,time:number):DeviceAutostartView{
 const items=demoAutostartEntries(serverId,time).sort((a,b)=>a.name.localeCompare(b.name));
 return {state:{checksum:hex('autostart'+serverId,64),reportedAt:time-10*60000,count:items.length,truncated:false,baselineAt:time-30*day},items,canConfirm:false,reason:null};
}
/** The autostart summary of a sample device, as GET /api/console sends it. */
export function demoAutostartSummary(serverId:string,time:number):AutostartSummary{
 const items=demoAutostartEntries(serverId,time),fresh=items.filter(item=>item.isNew);
 return {reportedAt:time-10*60000,count:items.length,newCount:fresh.length,suspiciousNewCount:fresh.filter(item=>item.suspicious).length,
  newEntries:fresh.map(item=>({id:item.id,name:item.name,category:item.category,suspicious:item.suspicious,firstSeen:item.firstSeen}))};
}
/** The Autostart tab over sample devices, grouped like GET /api/autostart (rare entries first). */
export function demoAutostartFleet(deviceIds:readonly string[],query:string,time:number):AutostartFleetView{
 const tokens=autostartSearchTokens(query),groups=new Map<string,{entry:AutostartEntry;deviceIds:Set<string>;newDeviceIds:Set<string>}>();
 for(const id of deviceIds)for(const entry of demoAutostartEntries(id,time)){
  if(tokens.length&&!autostartMatches(entry,tokens))continue;
  const key=JSON.stringify([entry.category,entry.name.toLowerCase(),(entry.target??'').toLowerCase()]),group=groups.get(key)??{entry,deviceIds:new Set<string>(),newDeviceIds:new Set<string>()};
  group.deviceIds.add(id);if(entry.isNew)group.newDeviceIds.add(id);groups.set(key,group);
 }
 const rows=[...groups.values()].map(({entry,deviceIds:ids,newDeviceIds})=>({name:entry.name,category:entry.category,target:entry.target,signature:entry.signature,signer:entry.signer,publisher:entry.publisher,userPath:entry.userPath,deviceCount:ids.size,newCount:newDeviceIds.size,deviceIds:[...ids].sort(),newDeviceIds:[...newDeviceIds].sort()}))
  .sort((a,b)=>a.deviceCount-b.deviceCount||a.name.localeCompare(b.name));
 return {rows,total:rows.length,truncated:false};
}

/** The snapshot fields of agent 4.11.0 of a sample device. */
export function demoHealthSignals2(serverId:string,time:number):Partial<ServerSnapshot>{
 return {driverHealth:demoDriverHealth(serverId,time),reliability:demoReliability(serverId,time),diskHealth:demoDiskHealth(serverId,time),battery:demoBattery(serverId,time),certificates:demoCertificates(serverId,time),autostartChecksum:hex('autostart'+serverId,64)};
}

/**
 * Microsoft Defender of agent 4.14.0 on the sample devices: SRV-APP01 has two
 * active detections and a quarantined one, SRV-SQL01 a quick scan 12 days old
 * and the SQL Server exclusions, SRV-FILE01 runs Defender in passive mode next
 * to a named third-party antivirus, and SRV-DC01 runs an older agent without
 * the capability (no defender key). Paths and users are illustrative.
 * SRV-SQL01 also runs a quick scan that the portal started 6 minutes ago
 * (defenderScan of agent 4.15.0).
 */
export function demoDefender(serverId:string,time:number):Pick<ServerSnapshot,'defender'|'defenderScan'>{
 const at=(offset:number)=>new Date(time-offset).toISOString(),none={paths:[],extensions:[],processes:[]};
 const base={available:true as const,collectedAt:at(4*60000),mode:'normal' as const,antivirusEnabled:true,realTimeProtection:true,tamperProtected:true,
  quickScanAt:at(20*hour),fullScanAt:at(6*day),signatureAt:at(hour),signatureVersion:'1.421.1868.0',productVersion:'4.18.24090.11',
  otherAntivirus:null,detectionCount:0,activeCount:0,highestActiveSeverity:null,truncated:false,detections:[],exclusions:none};
 if(serverId==='demo-dc')return {};
 if(serverId==='demo-app')return {defender:{...base,detectionCount:3,activeCount:2,highestActiveSeverity:'severe',detections:[
  {id:'{6A1D0B2E-1A2B-4C3D-8E9F-000000000001}',threatId:'2147812345',name:'Trojan:Win32/Wacatac.B!ml',severity:'severe',status:'detected',active:true,path:'C:\\Users\\demo.user\\Downloads\\invoice-2026.pdf.exe',resourceCount:2,at:at(3*hour),user:'CONTOSO\\demo.user'},
  {id:'{6A1D0B2E-1A2B-4C3D-8E9F-000000000002}',threatId:'2147723456',name:'HackTool:Win32/Example',severity:'high',status:'failed',active:true,path:'C:\\ProgramData\\Example\\tool.exe',resourceCount:1,at:at(26*hour),user:'CONTOSO\\svc-backup'},
  {id:'{6A1D0B2E-1A2B-4C3D-8E9F-000000000003}',threatId:'2147519003',name:'Virus:DOS/EICAR_Test_File',severity:'severe',status:'quarantined',active:false,path:'C:\\Users\\demo.user\\Downloads\\eicar.txt',resourceCount:1,at:at(5*day),user:'CONTOSO\\demo.user'}]}};
 if(serverId==='demo-db')return {defenderScan:{kind:'quick',startedAt:at(6*60000)},defender:{...base,quickScanAt:at(12*day),fullScanAt:at(40*day),
  exclusions:{paths:['D:\\SQLData','D:\\SQLLogs','C:\\Program Files\\Microsoft SQL Server\\MSSQL16.MSSQLSERVER\\MSSQL\\Backup'],extensions:['.mdf','.ldf','.ndf','.bak'],processes:['sqlservr.exe','sqlagent.exe']}}};
 return {defender:{...base,mode:'passive',realTimeProtection:false,tamperProtected:false,quickScanAt:at(31*day),fullScanAt:null,otherAntivirus:[{name:'Contoso Endpoint Security',enabled:true}]}};
}
