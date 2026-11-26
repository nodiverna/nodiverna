// Disk and battery health (docs/device-health-signals.md#disk-and-battery-health):
// the strict snapshot schemas, the helpers of ui/devices/inventory/health-signals.ts, the rules
// disk-health-failed, ssd-wear, disk-errors and battery-capacity, the fleet
// filters and column sort, and the issue texts. No database.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
const {telemetry,diskHealthState,batteryState}=await import('../../../lib/server/agent/telemetry.ts');
const {defaultAlertSettings,evaluateAlertRules}=await import('../../../lib/alert-rules.ts');
const {deviceIssues,issueTarget}=await import('../../../ui/base/ui-device.ts');
const {diskHealthStatus,deviceDiskHealth,maxWear,batteryHealth,diskOfDrive}=await import('../../../ui/devices/inventory/health-signals.ts');
const {fleetFilterMatch}=await import('../../../ui/devices/fleet/fleet-filters.ts');
const {compareFleetDevices}=await import('../../../ui/devices/fleet/fleet-sort.ts');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};

const now=Date.parse('2026-10-20T12:00:00.000Z'),day=86400000,iso=offset=>new Date(now-offset).toISOString();
const base={hostname:'H',os:'Windows 11 Pro',build:'26100',manufacturer:'',model:'',domain:'',cores:4,memoryGb:16,cpu:5,memory:30,uptimeSeconds:10,rebootPending:false,management:false,disks:[],services:[],processes:[],events:[],networks:[],hotfixes:[],collectionErrors:[],protocolVersion:3,agentVersion:'4.11.0',mode:'ReadOnly',publicKey:{kty:'RSA',n:'a'.repeat(342),e:'AQAB'},agentCapabilities:[]};
const disk=(id,extra={})=>({id,number:Number(id),model:`Disk ${id}`,busType:'NVMe',mediaType:'ssd',health:'healthy',operationalStatus:['ok'],driveLetters:[],countersAvailable:true,wearPercent:10,temperatureC:40,temperatureMaxC:60,readErrorsUncorrected:0,powerOnHours:1200,...extra});
const usb=id=>disk(id,{model:'USB Stick',busType:'USB',mediaType:'unspecified',health:'unknown',operationalStatus:['unknown'],countersAvailable:false,wearPercent:null,temperatureC:null,temperatureMaxC:null,readErrorsUncorrected:null,powerOnHours:null});
const health=(disks,counts={},items=[])=>({collectedAt:iso(0),disks,events:{windowDays:30,items,counts,truncated:false}});
const battery=(batteries,extra={})=>({collectedAt:iso(0),present:true,batteries,...extra});
const cell=(id,healthPercent,extra={})=>({id,name:'DELL 7FHN',designCapacityMWh:60000,fullChargeCapacityMWh:healthPercent===null?null:healthPercent*600,healthPercent,cycleCount:312,...extra});

// ---- Schema ----
const good=health([disk('0',{driveLetters:['C:']}),usb('1')],{0:2,unknown:1},[{at:iso(day),source:'disk',eventId:7,disk:0,volume:null},{at:iso(2*day),source:'ntfs',eventId:55,disk:null,volume:'D:'}]);
check(telemetry.safeParse({...base,diskHealth:good,battery:battery([cell(0,54)])}).success,true,'valid disk health and battery');
check(telemetry.safeParse({...base,battery:{collectedAt:iso(0),present:false,reason:'no-battery',batteries:[]}}).success,true,'no battery');
check(telemetry.safeParse({...base,agentVersion:'4.10.0'}).success,true,'a 4.10.x snapshot without the fields stays valid');
for(const [label,value] of [
 ['a serial number',health([disk('0',{serialNumber:'S3Z'})])],
 ['an unknown media type',health([disk('0',{mediaType:'tape'})])],
 ['an unknown health',health([disk('0',{health:'broken'})])],
 ['a wear above 100',health([disk('0',{wearPercent:101})])],
 ['a drive that is no letter',health([disk('0',{driveLetters:['C:\\']})])],
 ['an unknown event ID',health([disk('0')],{},[{at:iso(day),source:'disk',eventId:11,disk:0,volume:null}])],
 ['an unknown counts key',health([disk('0')],{sda:1})],
 ['a zero count',health([disk('0')],{0:0})],
 ['more than 64 disks',health(Array.from({length:65},(_,index)=>disk(String(index))))],
])check(diskHealthState.safeParse(value).success,false,`rejects ${label}`);
for(const [label,value] of [
 ['a missing battery without reason',{collectedAt:iso(0),present:false,batteries:[]}],
 ['a missing battery with a list',{collectedAt:iso(0),present:false,reason:'no-battery',batteries:[cell(0,90)]}],
 ['a health above 150',battery([cell(0,151)])],
 ['more than 4 batteries',battery([0,1,2,3,3].map(id=>cell(id,90)))],
 ['an unknown key',battery([{...cell(0,90),serial:'X'}])],
])check(batteryState.safeParse(value).success,false,`rejects ${label}`);

// ---- Helpers ----
check([diskHealthStatus(disk('0')),diskHealthStatus(disk('0',{health:'warning'})),diskHealthStatus(disk('0',{health:'unhealthy'})),diskHealthStatus(disk('0',{operationalStatus:['predictive-failure']})),diskHealthStatus(disk('0',{operationalStatus:['failed']})),diskHealthStatus(disk('0',{operationalStatus:['degraded']})),diskHealthStatus(usb('1')),diskHealthStatus(disk('0',{health:'unknown'}))],
 ['healthy','warning','failed','failed','failed','warning','not-available','healthy'],'diskHealthStatus: unknown without counters is not available');
const server=snapshot=>({snapshot:{...base,...snapshot}});
check([deviceDiskHealth(server({diskHealth:health([disk('0'),disk('1',{health:'unhealthy'}),usb('2')])})),deviceDiskHealth(server({diskHealth:health([usb('2')])})),deviceDiskHealth(server({}))],['failed','not-available',null],'deviceDiskHealth: the worst disk, null for an older agent');
check([maxWear(server({diskHealth:health([disk('0',{wearPercent:86}),disk('1',{wearPercent:12}),usb('2')])})),maxWear(server({diskHealth:health([usb('2')])}))],[86,null],'maxWear ignores disks without a value');
check([batteryHealth(server({battery:battery([cell(0,54),cell(1,80)])})),batteryHealth(server({battery:{collectedAt:iso(0),present:false,reason:'no-battery',batteries:[]}})),batteryHealth(server({battery:battery([],{reason:'not-supported'})})),batteryHealth(server({battery:battery([cell(0,null,{designCapacityMWh:0})])})),batteryHealth(server({}))],[54,'not-available','not-available','not-available','not-available'],'batteryHealth: the lowest battery, else not available');
check(diskOfDrive(health([disk('0',{driveLetters:['C:','D:']})]),'d:\\')?.id,'0','a drive letter finds its disk');

// ---- Rules ----
const issues=(snapshot,settings=defaultAlertSettings())=>evaluateAlertRules({lastSeen:now,snapshot:{...base,...snapshot}},settings,now).filter(issue=>/^(disk-health-failed|ssd-wear|disk-errors|battery-capacity)$/.test(issue.ruleId));
const keys=(snapshot,settings)=>issues(snapshot,settings).map(issue=>`${issue.key}:${issue.level}`).sort();
check(keys({diskHealth:health([disk('0',{health:'unhealthy'})])}),['disk-health-0:critical'],'unhealthy: critical');
check(keys({diskHealth:health([disk('0',{operationalStatus:['ok','predictive-failure']})])}),['disk-health-0:critical'],'predictive failure: critical');
check(keys({diskHealth:health([disk('0',{health:'warning'})])}),['disk-health-0:critical'],'health warning is an error state');
check(keys({diskHealth:health([disk('0')])}),[],'healthy: no issue');
check(keys({diskHealth:health([disk('0',{operationalStatus:['degraded']})])}),[],'degraded alone is no error state');
check(keys({diskHealth:health([disk('0',{wearPercent:79})])}),[],'wear 79: no issue');
check(keys({diskHealth:health([disk('0',{wearPercent:80})])}),['ssd-wear-0:warning'],'wear 80: warning');
check(keys({diskHealth:health([disk('0',{wearPercent:95})])}),['ssd-wear-0:critical'],'wear 95: critical');
check(issues({diskHealth:health([disk('0',{wearPercent:86})])})[0].params,{name:'Disk 0',percent:86},'ssd-wear params');
check(keys({diskHealth:health([usb('1')])}),[],'missing counters: no issue');
check(keys({diskHealth:health([disk('0'),disk('1')],{1:3,unknown:2})}),['disk-errors-1:warning','disk-errors-unknown:warning'],'disk errors per disk and under unknown');
check(issues({diskHealth:health([disk('0'),disk('1')],{1:3})})[0].params,{disk:'1',name:'Disk 1',count:3},'disk-errors params');
check(keys({battery:battery([cell(0,59)])}),['battery-0:info'],'battery 59: info');
check(keys({battery:battery([cell(0,60)])}),[],'battery 60: no issue');
check(issues({battery:battery([cell(0,54)])})[0].params,{percent:54,full:32400,design:60000},'battery params');
check(keys({battery:{collectedAt:iso(0),present:false,reason:'no-battery',batteries:[]}}),[],'no battery: no issue');
check(keys({battery:battery([cell(0,null,{designCapacityMWh:0})])}),[],'no value: no issue');
check(keys({battery:battery([cell(0,54)])},{...defaultAlertSettings(),'battery-capacity':{enabled:true,warning:50,critical:null,level:'critical'}}),[],'an override threshold below the value');
check(keys({battery:battery([cell(0,44)])},{...defaultAlertSettings(),'battery-capacity':{enabled:true,warning:50,critical:null,level:'critical'}}),['battery-0:critical'],'the level of a limit override');
check(keys({}),[],'an older agent: no issue');

// ---- Fleet filters and column sort ----
const device=(id,snapshot)=>({id,name:id,createdAt:0,revoked:0,management:0,lastSeen:now,snapshot:{...base,...snapshot}});
const fleet=[
 device('failed',{diskHealth:health([disk('0',{health:'unhealthy',wearPercent:20})]),battery:battery([cell(0,90)])}),
 device('worn',{diskHealth:health([disk('0',{wearPercent:86})],{0:4}),battery:battery([cell(0,54)])}),
 device('fine',{diskHealth:health([disk('0',{wearPercent:5})]),battery:{collectedAt:iso(0),present:false,reason:'no-battery',batteries:[]}}),
 device('usb',{diskHealth:health([usb('1')])}),
 device('old',{}),
];
const matching=filter=>fleet.filter(item=>fleetFilterMatch(item,filter,now)).map(item=>item.id);
check([matching('disk-failed'),matching('ssd-wear'),matching('disk-errors'),matching('battery')],[['failed'],['worn'],['worn'],['worn']],'the four filters with fixed values');
const sorted=sort=>[...fleet].sort((a,b)=>compareFleetDevices(a,b,sort,now)).map(item=>item.id);
check(sorted('diskHealth:asc'),['failed','fine','worn','old','usb'],'disk health: problems first, not available and not reported last (by name)');
check(sorted('diskHealth:desc').slice(3),['old','usb'],'not available stays last in both directions');
check(sorted('ssdWear:desc').slice(0,3),['worn','failed','fine'],'SSD wear: highest first');
check(sorted('ssdWear:desc').slice(3).sort(),['old','usb'],'no wear value last');
check(sorted('battery:asc').slice(0,2),['worn','failed'],'battery: lowest first');
check(sorted('battery:desc').slice(2).sort(),['fine','old','usb'],'no battery stays last in both directions');

// ---- Issue texts and links ----
const evaluated=snapshot=>{const item=device('d',snapshot);return {...item,issues:evaluateAlertRules(item,defaultAlertSettings(),now)};};
const texts=(snapshot,locale)=>deviceIssues(evaluated(snapshot),now,locale).map(item=>[item.title,item.detail]);
const sample={diskHealth:health([disk('0',{model:'Samsung 980',wearPercent:86}),disk('1',{model:'WD Blue',mediaType:'hdd',wearPercent:null,operationalStatus:['predictive-failure']})],{1:3,unknown:1}),battery:battery([cell(0,54)])};
check(texts(sample,'en'),[
 ['Disk WD Blue reports an error state','Health: healthy. Status: failure predicted.'],
 ['SSD Samsung 980 is 86% worn','Replace the disk before it fails.'],
 ['Disk errors on WD Blue','3 errors in the System event log in the last 30 days.'],
 texts(sample,'en')[3],
 ['Battery at 54% of design capacity','32.4 Wh of 60 Wh.'],
],'texts (en)');
check(texts(sample,'de')[1],['SSD Samsung 980 ist zu 86 % verschlissen','Tausche den Datenträger, bevor er ausfällt.'],'ssd text (de)');
check(texts(sample,'de')[4],['Akku bei 54 % der Designkapazität','32,4 Wh von 60 Wh.'],'battery text (de)');
const targets=evaluated(sample).issues.map(issue=>[issue.ruleId,issueTarget(issue,evaluated(sample))]);
check(targets.map(([,target])=>target),[{section:'management',management:'storage'},{section:'management',management:'storage'},{section:'management',management:'storage'},{section:'management',management:'storage'},{section:'hardware',hardware:'overview'}],'disk rules open Storage, battery opens the hardware overview');

console.log(`PASS disk and battery health (${checks} checks): strict schemas, diskHealthStatus/deviceDiskHealth/maxWear/batteryHealth, the four rules with their boundaries, fleet filters and column sort, issue texts and links.`);
