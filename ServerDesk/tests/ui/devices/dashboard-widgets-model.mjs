// What the Dashboard widgets count and list (ui/devices/dashboard/dashboard-widgets-model.ts, docs/dashboard.md): alarms
// per day, device health, device status, pinned devices, customers, highest load, disk space, restart required,
// operating system support, agent versions, Microsoft Defender, drive encryption, certificates, new autostart entries,
// disk health, crashes, failed jobs, runbook runs and recent activity. For each: its count, its tone inputs, its breakdown, the
// order of its rows, and that a revoked device is never counted.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
const model=await import('../../../ui/devices/dashboard/dashboard-widgets-model.ts');
const {alarmWeekGrid,alarmWeekStart}=await import('../../../ui/devices/dashboard/dashboard-model.ts');
const {alarmTrend,healthWidget,statusWidget,pinnedWidget,customersWidget,loadWidget,diskSpaceWidget,restartWidget,osSupportWidget,agentsWidget,defenderWidget,encryptionWidget,certificatesWidget,autostartWidget,diskHealthWidget,crashesWidget,failedJobsWidget,runbooksWidget,activityWidget,highLoadPercent,fullDiskPercent,failedJobStates}=model;
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};

const minute=60_000,hour=3_600_000,day=24*hour,now=Date.UTC(2026,10,18,14,20);
let alertId=0;
const alert=(level,startedAt=now-hour,ruleId='cpu-usage')=>({id:'a'+(++alertId),ruleId,key:'',level,peakLevel:level,peakValue:null,threshold:null,params:{},startedAt,openedAt:startedAt,acknowledged:null,muted:null});
const device=(name,extra={})=>({id:name.toLowerCase(),name,createdAt:0,lastSeen:now-30_000,revoked:0,management:1,snapshot:{},...extra});
const gone=extra=>device('Gone',{revoked:1,...extra});
const names=rows=>rows.map(row=>(row.device??row).name);
const parts=list=>Object.fromEntries(list.map(part=>[part.id,part.count]));
const tones=list=>Object.fromEntries(list.map(part=>[part.id,part.tone]));

// ---- Alarms per day ----
const utc=(time,dayOffset,localHour)=>{const date=new Date(time);return Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate()+dayOffset,localHour);};
const week=counts=>{const start=alarmWeekStart(now),hours=new Array(192).fill(0);for(const [at,count] of Object.entries(counts))hours[Math.floor((Number(at)-start)/hour)]=count;return {start,hours};};
let trend=alarmTrend(alarmWeekGrid(week({[Date.UTC(2026,10,18,9)]:2,[Date.UTC(2026,10,18,11)]:1,[Date.UTC(2026,10,17,14)]:8,[Date.UTC(2026,10,12,0)]:1}),now,utc));
check([trend.today,trend.total,trend.max,trend.days.map(item=>item.count),trend.days[0].at,trend.days[6].at],[3,12,8,[1,0,0,0,0,8,3],Date.UTC(2026,10,12),Date.UTC(2026,10,18)],'seven local days, the oldest first; today is the last');
trend=alarmTrend(alarmWeekGrid(week({}),now,utc));
check([trend.today,trend.total,trend.max],[0,0,0],'a week without an alarm');

// ---- Device health ----
const healthServers=[
 device('Warn',{alerts:[alert('warning',now-3*hour)]}),
 device('Crit',{alerts:[alert('warning',now-9*hour),alert('critical',now-hour)]}),
 device('Info',{alerts:[alert('info')]}),device('Fine'),
 device('New',{lastSeen:null,snapshot:null}),
 device('OldCrit',{alerts:[alert('critical',now-5*hour)]}),
 gone({alerts:[alert('critical')]}),
];
const health=healthWidget(healthServers);
check([health.count,health.critical,parts(health.parts),tones(health.parts)],[3,2,{critical:2,warning:1,good:2,unknown:1},{critical:'critical',warning:'warning',good:'ok',unknown:'neutral'}],'three devices need attention; every device counts once by its level; a device without a report has no data');
check([names(health.rows),health.rows[1].reasons.map(reason=>reason.level)],[['OldCrit','Crit','Warn'],['critical','warning']],'critical first, the one open longest first; a row lists its alarms, the worst first');
check(healthWidget([device('A')]).count,0,'a healthy fleet');

// ---- Device status ----
const statusServers=[device('On1'),device('On2'),device('Off',{lastSeen:now-5*minute}),device('Never',{lastSeen:null}),device('Updating',{lastSeen:now-9*minute,maintenance:{state:'updating'}}),gone()];
const status=statusWidget(statusServers,now);
check([status.online,status.devices,parts(status.parts),tones(status.parts)],[2,5,{online:2,offline:1,maintenance:1,waiting:1},{online:'ok',offline:'warning',maintenance:'data',waiting:'neutral'}],'every device by its connection');

// ---- Pinned devices ----
const pinned=pinnedWidget([device('A'),device('B'),device('C'),gone()],['c','missing','a','gone']);
check([pinned.count,names(pinned.rows)],[2,['C','A']],'the pins in pin order; a pin without a device, or of a removed one, is left out');
check(pinnedWidget([device('A')],[]),{count:0,rows:[]},'no pin');

// ---- Customers ----
const customers=[{id:'k1',name:'Kiwi'},{id:'k2',name:'Apple'},{id:'k3',name:'Empty'},{id:'k4',name:'Berry'}];
const customerServers=[
 device('A',{customerId:'k1',alerts:[alert('warning')]}),device('B',{customerId:'k1',lastSeen:now-hour}),
 device('C',{customerId:'k2',alerts:[alert('critical'),alert('info')]}),device('D',{customerId:'k4',lastSeen:now-hour}),device('E',{customerId:'k4',lastSeen:now-hour}),
 device('Other',{customerId:'unknown'}),device('None'),gone({customerId:'k3',alerts:[alert('critical')]}),
];
const byCustomer=customersWidget(customerServers,customers,now);
check([byCustomer.count,byCustomer.rows.map(row=>[row.name,row.devices,row.alarms,row.critical,row.offline])],[4,[['Apple',1,2,1,0],['Kiwi',2,1,0,1],['Berry',2,0,0,2],['Empty',0,0,0,0]]],'one row per visible customer: the most open alarms first, then the most offline devices, then the name; a device of another customer is not counted');

// ---- Highest load ----
const load=loadWidget([device('Calm',{snapshot:{cpu:12,memory:40}}),device('Hot',{snapshot:{cpu:97,memory:50}}),device('Full',{snapshot:{cpu:20,memory:90}}),device('Half',{snapshot:{cpu:null,memory:64}}),
 device('Away',{lastSeen:now-hour,snapshot:{cpu:99,memory:99}}),device('Blank',{snapshot:{cpu:null}}),device('Null',{snapshot:null}),gone({snapshot:{cpu:99,memory:99}})],now);
check([highLoadPercent,load.count,load.online,load.rows.map(row=>[row.device.name,row.cpu,row.memory,row.peak])],[90,2,4,[['Hot',97,50,97],['Full',20,90,90],['Half',null,64,64],['Calm',12,40,40]]],'the online devices that report a value, the higher of CPU and RAM first; two are at 90 % or more; an offline device has no live value');
check(loadWidget([device('Away',{lastSeen:now-hour,snapshot:{cpu:50,memory:50}})],now),{count:0,online:0,rows:[]},'no device is online');

// ---- Disk space ----
const disk=(name,totalGb,freeGb)=>({name,label:'',totalGb,freeGb});
const space=diskSpaceWidget([device('A',{snapshot:{disks:[disk('C:',100,5),disk('D:',200,100)]}}),device('B',{snapshot:{disks:[disk('C:',50,5),disk('E:',0,0),disk('F:',10,NaN)]}}),device('C',{snapshot:{disks:[disk('C:',100,3)]}}),device('D'),gone({snapshot:{disks:[disk('C:',100,0)]}})]);
check([fullDiskPercent,space.count,space.devices,space.rows.map(row=>[row.device.name,row.disk.name,Math.round(row.used)])],[90,3,3,[['C','C:',97],['A','C:',95],['B','C:',90],['A','D:',50]]],'every drive with a size, the fullest first; three are at 90 % or more, on three devices');
check(diskSpaceWidget([device('A')]),{count:0,devices:0,rows:[]},'no drive reported');

// ---- Restart required ----
const restart=restartWidget([device('B',{snapshot:{rebootPending:true,rebootReasons:['windows-update','file-replacement']}}),device('A',{snapshot:{rebootPending:true}}),device('C',{snapshot:{rebootPending:false}}),gone({snapshot:{rebootPending:true}})]);
check([restart.count,restart.rows.map(row=>[row.device.name,row.reason])],[2,[['A',null],['B','windows-update']]],'the devices that wait for a restart, by name, each with its first reason');

// ---- Operating system support ----
const support=(statusValue,end)=>({status:statusValue,effectiveEnd:end});
const os=osSupportWidget([device('Ok',{osSupport:support('supported','2031-10-14')}),device('Soon',{osSupport:support('ending','2027-01-12')}),device('Old',{osSupport:support('ended','2020-01-14')}),device('Older',{osSupport:support('ended','2015-07-14')}),
 device('Soonest',{osSupport:support('ending','2026-12-08')}),device('What',{osSupport:{status:'unknown',reason:'no-entry'}}),device('Nothing'),gone({osSupport:support('ended','2010-01-01')})]);
check([os.count,os.ended,parts(os.parts),tones(os.parts),names(os.rows)],[4,2,{ended:2,ending:2,supported:1,unknown:2},{ended:'critical',ending:'warning',supported:'ok',unknown:'neutral'},['Older','Old','Soonest','Soon']],'ended first, then ending, each by the earlier date; a device without a status is unknown');

// ---- Agent versions ----
const agent=version=>({snapshot:{agentVersion:version}});
const agents=agentsWidget([device('A',agent('4.19.0')),device('B',agent('4.9.2')),device('C',agent('4.19.0')),device('D',agent('4.18.1')),device('E',agent('4.9.2')),device('F',agent('4.9.2')),device('G'),gone(agent('5.0.0'))]);
check([agents.count,agents.devices,agents.newest,agents.rows,parts(agents.parts)],[4,6,'4.19.0',[{version:'4.19.0',count:2},{version:'4.18.1',count:1},{version:'4.9.2',count:3}],{newest:2,older:4}],'the reported versions, the newest first by their numbers (4.19 is newer than 4.9); four devices run an older one');
check(agentsWidget([device('A')]),{count:0,devices:0,newest:null,rows:[],parts:[{id:'newest',count:0,tone:'data'},{id:'older',count:0,tone:'neutral'}]},'no agent reported');

// ---- Microsoft Defender ----
const defenderCapability=['defender-status'];
const defenderState=(extra={})=>({snapshot:{agentCapabilities:defenderCapability,defender:{available:true,collectedAt:'',mode:'normal',antivirusEnabled:true,realTimeProtection:true,tamperProtected:true,activeCount:0,...extra}}});
const issue=ruleId=>({ruleId,key:ruleId,level:'warning',params:{},live:false});
const defender=defenderWidget([
 device('Safe',defenderState()),device('Threat',defenderState({activeCount:2})),device('Off',{...defenderState({antivirusEnabled:false}),issues:[issue('defender-off')]}),device('Stale',{...defenderState(),issues:[issue('scan-age')]}),
 device('Passive',defenderState({mode:'passive'})),device('NoDefender',{snapshot:{agentCapabilities:defenderCapability,defender:{available:false,reason:'not-installed',collectedAt:''}}}),device('OldAgent',{snapshot:{agentCapabilities:[]}}),device('Blank',{snapshot:null}),
 device('AThreat',defenderState({activeCount:1})),gone(defenderState({activeCount:5})),
]);
check([defender.count,defender.urgent,parts(defender.parts),tones(defender.parts)],[4,3,{threat:2,off:1,'scan-old':1,protected:1,other:4},{threat:'critical',off:'critical','scan-old':'warning',protected:'ok',other:'neutral'}],'four devices need attention, three of them urgently; passive, not installed, an old agent and no report are "other"');
check(defender.rows.map(row=>[row.device.name,row.status]),[['AThreat','threat'],['Threat','threat'],['Off','off'],['Stale','scan-old']],'a threat first, then protection off, then an old scan; by name inside a status');

// ---- Drive encryption ----
const bitlocker=(conversion,protection='on')=>({snapshot:{bitlocker:{available:true,collectedAt:'',volumes:[{drive:'C:',volumeType:'os',conversion,percent:null,protection,method:'xts-aes-256',protectors:[],suspendedSince:null}]}}});
const encryption=encryptionWidget([device('Enc',bitlocker('encrypted')),device('Plain',bitlocker('decrypted','off')),device('Paused',bitlocker('encrypted','suspended')),device('Busy',bitlocker('encrypting')),
 device('NoTpm',{snapshot:{bitlocker:{available:false,reason:'not-supported',collectedAt:'',volumes:[]}}}),device('Silent'),device('APlain',bitlocker('decrypted','off')),gone(bitlocker('decrypted','off'))]);
check([encryption.count,parts(encryption.parts),tones(encryption.parts),encryption.rows.map(row=>[row.device.name,row.status])],
 [3,{'not-encrypted':2,suspended:1,encrypting:1,encrypted:1,none:2},{'not-encrypted':'warning',suspended:'warning',encrypting:'data',encrypted:'ok',none:'neutral'},[['APlain','not-encrypted'],['Plain','not-encrypted'],['Paused','suspended']]],'the devices whose system drive is not encrypted or whose protection is suspended; not available and not reported are "no data"');

// ---- Certificates ----
const cert=(thumbprint,daysLeft,subject='CN='+thumbprint)=>({thumbprint,stores:['My'],subject,sans:[],issuer:'CN=CA',notBefore:new Date(now-90*day).toISOString(),notAfter:new Date(now+daysLeft*day).toISOString(),hasPrivateKey:true,selfSigned:false,bindings:[]});
const certificates=certificatesWidget([device('Web',{snapshot:{certificates:{collectedAt:'',truncated:false,items:[cert('soon',12),cert('long',400),cert('gone',-3)]}}}),device('Mail',{snapshot:{certificates:{collectedAt:'',truncated:false,items:[cert('edge',30),cert('next',31),cert('older',-40)]}}}),device('None'),gone({snapshot:{certificates:{collectedAt:'',truncated:false,items:[cert('revoked',-1)]}}})],now);
check([certificates.count,certificates.expired,certificates.expiring,certificates.rows.map(row=>[row.deviceName,row.cert.thumbprint,row.status])],[4,2,2,[['Mail','older','expired'],['Web','gone','expired'],['Web','soon','expiring'],['Mail','edge','expiring']]],'expired first, then the fewest days left; 30 days is still "expiring", 31 is valid');
check(certificatesWidget([device('A')],now),{count:0,expired:0,expiring:0,rows:[]},'no certificate expires soon');

// ---- New autostart entries ----
const entry=(id,suspicious,firstSeen)=>({id,name:id,category:'run',suspicious,firstSeen});
const autostart=autostartWidget([device('A',{autostart:{reportedAt:now,count:40,newCount:7,suspiciousNewCount:1,newEntries:[entry('updater',false,now-hour),entry('odd.exe',true,now-5*hour)]}}),
 device('B',{autostart:{reportedAt:now,count:10,newCount:1,suspiciousNewCount:1,newEntries:[entry('loader',true,now-2*hour)]}}),device('C',{autostart:{reportedAt:now,count:5,newCount:0,suspiciousNewCount:0,newEntries:[]}}),device('D'),
 gone({autostart:{reportedAt:now,count:1,newCount:9,suspiciousNewCount:9,newEntries:[entry('bad',true,now)]}})]);
check([autostart.count,autostart.suspicious,autostart.rows.map(row=>[row.device.name,row.entry.id])],[8,2,[['B','loader'],['A','odd.exe'],['A','updater']]],'the devices\' own totals (a device lists only its first new entries); suspicious first, then the newest');

// ---- Disk health ----
const disks=(...states)=>({snapshot:{diskHealth:{collectedAt:'',disks:states.map(([health,operationalStatus=['ok'],countersAvailable=true])=>({health,operationalStatus,countersAvailable})),events:{windowDays:30,items:[],counts:{},truncated:false}}}});
const diskHealth=diskHealthWidget([device('Good',disks(['healthy'])),device('Bad',disks(['healthy'],['unhealthy'])),device('Shaky',disks(['warning'])),device('Predict',disks(['healthy',['predictive-failure']])),device('Blind',disks(['unknown',['ok'],false])),device('Old'),gone(disks(['unhealthy']))]);
check([diskHealth.count,diskHealth.failed,parts(diskHealth.parts),tones(diskHealth.parts),diskHealth.rows.map(row=>[row.device.name,row.status])],
 [3,2,{failed:2,warning:1,healthy:1,'not-available':2},{failed:'critical',warning:'warning',healthy:'ok','not-available':'neutral'},[['Bad','failed'],['Predict','failed'],['Shaky','warning']]],'a device counts by its worst disk; failed first; a device that reports no disk health has no data');

// ---- Crashes ----
const crash=(daysAgo,id=String(daysAgo))=>({id,kind:'bugcheck',at:new Date(now-daysAgo*day).toISOString(),stopCode:null,parameters:null,driver:null,source:'event',dumpFile:null,dumpStatus:'none',detail:null});
const crashes=crashesWidget([device('Once',{snapshot:{crashes:[crash(3)]}}),device('Often',{snapshot:{crashes:[crash(10),crash(2),crash(20),crash(45)]}}),device('Twice',{snapshot:{crashes:[crash(1),crash(4)]}}),device('Long',{snapshot:{crashes:[crash(31)]}}),device('Never'),gone({snapshot:{crashes:[crash(1)]}})],now);
check([crashes.count,crashes.devices,crashes.rows.map(row=>[row.device.name,row.count,(now-row.last)/day])],[6,3,[['Often',3,2],['Twice',2,1],['Once',1,3]]],'the crashes of the last 30 days; the device with the most first; last is its latest crash');
check(crashesWidget([device('A')],now),{count:0,devices:0,rows:[]},'no crash');

// ---- Failed jobs ----
const job=(id,state,extra={})=>({id,serverId:'a',action:'restart-service',target:'',state,createdAt:now-3*hour,claimedAt:null,result:null,actor:'x',...extra});
const failed=failedJobsWidget([job('ok','succeeded'),job('f1','failed',{lastProgress:now-hour}),job('f2','expired',{createdAt:now-2*hour}),job('f3','unknown',{claimedAt:now-10*minute}),job('old','failed',{lastProgress:now-25*hour,createdAt:now-26*hour}),job('run','running'),job('edge','failed',{lastProgress:now-day,createdAt:now-2*day})],now);
check([failedJobStates,failed.count,failed.rows.map(item=>item.id)],[['failed','expired','unknown'],4,['f3','f1','f2','edge']],'failed, expired and unknown jobs of the last 24 hours, the newest first (by the last progress, else the claim, else the creation)');
check(failedJobsWidget([job('ok','succeeded')],now),{count:0,rows:[]},'no failed job');

// ---- Runbook runs ----
const run=(id,state,extra={})=>job(id,state,{action:'runbook-run',metadata:{runbookRunId:'run-'+id,completedSteps:1,totalSteps:3},...extra});
const runs=runbooksWidget([run('done','succeeded'),job('plain','running'),run('now','running'),run('later','pending',{notBefore:now+hour}),run('next','pending'),job('odd','succeeded',{action:'runbook-run'}),run('bad','failed')],now);
check([runs.count,runs.running,runs.waiting,runs.rows.map(item=>item.id)],[2,1,1,['now','later','next','done','bad']],'only jobs of a runbook run; the running and waiting ones first, then the others in the order of the job list; a scheduled run is not active');
check(runbooksWidget([job('plain','running')],now),{count:0,running:0,waiting:0,rows:[]},'no runbook run');

// ---- Recent activity ----
const audit=(id,at,scope='portal')=>({id,at,actor:'anna',action:'session.signIn',target:'',serverId:scope==='device'?'a':null,scope});
const activity=activityWidget([audit(3,now-hour),audit(1,now-30*hour)],[audit(2,now-2*hour,'device'),audit(3,now-hour),audit(4,now-hour,'device'),audit(5,now-day,'device')],now);
check([activity.count,activity.rows.map(item=>item.id)],[4,[4,3,2,5,1]],'portal and device entries, each id once, the newest first (the higher id at the same time); four in the last 24 hours');
check(activityWidget([],[],now),{count:0,rows:[]},'no entry');

console.log(`dashboard widgets model: ${checks} checks passed`);
