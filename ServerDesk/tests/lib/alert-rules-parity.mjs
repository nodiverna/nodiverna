// Parity of the alert rule catalog with the former browser rules: for every
// fixture the server evaluation with the default settings plus the formatting
// in deviceIssues returns exactly what the old deviceIssues returned (keys,
// titles, details, levels and order) in English and German. Also checks that
// deviceIssues drops live issues once `now` makes the device offline. The
// rule Device offline is new, so it is filtered out of the old fixtures and has
// fixtures of its own.
// No database, no device.
import '../support/register.mjs';
import assert from 'node:assert/strict';
const {deviceIssues}=await import('../../ui/base/ui-device.ts');
const {defaultAlertSettings,evaluateAlertRules}=await import('../../lib/alert-rules.ts');
const {translate}=await import('../../lib/i18n/translate.ts');
const {formatDate,formatDuration,formatNumber,formatPercent}=await import('../../lib/i18n/format.ts');

// ---- Frozen copy of deviceIssues before the rule catalog (ui/base/ui-device.ts) ----
// Only changes: the signatures title passes {count:7}, because the catalog entry is now a plural; the disk
// latency goes through formatDuration and the agent reasons through ui/base/agent-reasons.ts (UI-Rework 15), so
// the fixture reasons, which no agent writes, come back as received in unknown.
const online=(server,now)=>server.maintenance?.state!=='updating'&&!!server.lastSeen&&now-server.lastSeen<120000;
const rebootLabels={'windows-servicing':'device.reboot.windowsServicing','windows-update':'device.reboot.windowsUpdate','file-replacement':'device.reboot.fileReplacement','file-operations-unknown':'device.reboot.fileOperations'};
function oldDeviceIssues(server,now,locale){
 const s=server.snapshot;if(!s)return [];
 const issues=[],t=(key,params)=>translate(locale,key,params);
 const add=(key,title,detail,level='warning',unknown)=>issues.push({key,title,detail,...(unknown?{unknown}:{}),level});
 const current=online(server,now);
 if(current&&s.cpu!=null&&s.cpu>=80)add('cpu',t('device.issue.cpu'),formatPercent(locale,s.cpu),s.cpu>=90?'critical':'warning');
 if(current&&s.memory>=80)add('memory',t('device.issue.memory'),formatPercent(locale,s.memory),s.memory>=90?'critical':'warning');
 for(const d of s.disks){if(d.totalGb>0&&d.freeGb/d.totalGb<.15)add('disk-'+d.name,t('device.issue.diskLow',{name:d.name}),t('device.issue.diskFree',{size:formatNumber(locale,d.freeGb,{maximumFractionDigits:1}),percent:formatPercent(locale,d.freeGb/d.totalGb*100)}),d.freeGb/d.totalGb<.05?'critical':'warning');}
 if(s.rebootPending)add('reboot',t('device.issue.reboot'),s.rebootReasons?.map(reason=>Object.hasOwn(rebootLabels,reason)?t(rebootLabels[reason]):'').filter(Boolean).join(' · ')||t('device.issue.rebootDetail'));
 const p=s.performance;
 if(current&&p?.diskLatencyMs!=null&&p.diskLatencyMs>=50)add('latency',t('device.issue.latency'),formatDuration(locale,p.diskLatencyMs),p.diskLatencyMs>=100?'critical':'warning');
 if(current&&p?.pagefilePercent!=null&&p.pagefilePercent>=80)add('pagefile',t('device.issue.pagefile'),formatPercent(locale,p.pagefilePercent),p.pagefilePercent>=90?'critical':'warning');
 if(current&&p?.processorQueue!=null&&s.cores>0&&p.processorQueue>s.cores*2)add('queue',t('device.issue.queue'),t('device.issue.queueDetail',{threads:p.processorQueue,cores:s.cores}));
 const profiles=s.security?.firewall.filter(f=>!f.enabled)??[];
 if(profiles.length)add('firewall',t('device.issue.firewall'),profiles.map(f=>f.name).join(', '));
 const defender=s.security?.defender;
 if(defender?.available&&(!defender.enabled||!defender.realTimeProtection))add('defender',t('device.issue.defender'),t('device.issue.defenderDetail'));
 if(defender?.available&&defender.signatureAt&&now-Date.parse(defender.signatureAt)>7*86400000)add('signatures',t('device.issue.signatures',{count:7}),formatDate(locale,defender.signatureAt));
 if(s.updates?.checkedAt&&s.updates.pendingCount>0)add('updates',t('device.issue.updates',{count:s.updates.pendingCount}),t('device.issue.updatesDetail',{date:formatDate(locale,s.updates.checkedAt)}));
 if(s.collectionErrors.length)add('collection',t('device.issue.collection'),'','info',s.collectionErrors);
 return issues.sort((a,b)=>({critical:0,warning:1,info:2}[a.level]-{critical:0,warning:1,info:2}[b.level]));
}

// ---- Fixtures ----
const now=Date.UTC(2026,9,27,10),day=86400000;
const healthy={hostname:'SRV',os:'Microsoft Windows Server 2025 Datacenter',build:'26100',manufacturer:'M',model:'VM',domain:'WORKGROUP',cores:4,memoryGb:16,cpu:10,memory:20,uptimeSeconds:3600,rebootPending:false,management:true,protocolVersion:3,agentVersion:'4.0.0',mode:'Management',agentCapabilities:[],disks:[{name:'C:',label:'System',totalGb:100,freeGb:60}],services:[],processes:[],events:[],networks:[],hotfixes:[],collectionErrors:[],
 performance:{diskReadBytesSec:0,diskWriteBytesSec:0,networkBytesSec:0,diskLatencyMs:3,processorQueue:1,pagefilePercent:10},
 security:{domainJoined:false,domainRole:2,rdpEnabled:true,firewall:[{name:'Domain',enabled:true},{name:'Private',enabled:true},{name:'Public',enabled:true}],defender:{available:true,enabled:true,realTimeProtection:true,signatureAt:new Date(now-day).toISOString()},lastBoot:new Date(now-3600000).toISOString()},
 updates:{checkedAt:new Date(now-3600000).toISOString(),pendingCount:0,items:[]}};
const device=(snapshot,changes={})=>({id:'00000000-0000-4000-8000-000000000001',name:'SRV',createdAt:now-day,lastSeen:now-10000,revoked:0,management:1,snapshot:snapshot===null?null:{...healthy,...snapshot},...changes});
const fixtures=[['no snapshot',device(null)],['healthy online',device({})],['healthy offline',device({},{lastSeen:now-600000})],['maintenance',device({cpu:99},{maintenance:{state:'updating',version:'4.1.0',notBefore:now}})]];
for(const value of [79,80,89,90])for(const field of ['cpu','memory'])fixtures.push([`${field} ${value}`,device({[field]:value})]);
for(const value of [79,80,89,90])fixtures.push([`pagefile ${value}`,device({performance:{...healthy.performance,pagefilePercent:value}})]);
for(const value of [49,50,99,100])fixtures.push([`latency ${value}`,device({performance:{...healthy.performance,diskLatencyMs:value}})]);
for(const [label,freeGb,totalGb] of [['15 %',15,100],['14.9 %',14.9,100],['5 %',5,100],['4.9 %',4.9,100],['totalGb 0',0,0],['15 % of 1000',150,1000],['odd ratio',30.7,204.8]])fixtures.push([`disk ${label}`,device({disks:[{name:'C:',label:'System',totalGb:100,freeGb:60},{name:'D:',label:'Data',totalGb,freeGb}]})]);
fixtures.push(['queue 2*cores',device({performance:{...healthy.performance,processorQueue:8}})],['queue 2*cores+1',device({performance:{...healthy.performance,processorQueue:9}})],['queue cores 0',device({cores:0,performance:{...healthy.performance,processorQueue:9}})]);
fixtures.push(['reboot known reasons',device({rebootPending:true,rebootReasons:['windows-update','file-replacement']})],['reboot unknown reason',device({rebootPending:true,rebootReasons:['something-new']})],['reboot without reasons',device({rebootPending:true})],['no reboot',device({rebootPending:false,rebootReasons:[],pendingFileOperationsCount:3})]);
fixtures.push(['firewall profiles off',device({security:{...healthy.security,firewall:[{name:'Domain',enabled:false},{name:'Private',enabled:true},{name:'Public',enabled:false}]}})]);
for(const [label,defender] of [['defender unavailable',{available:false,enabled:false,realTimeProtection:false,signatureAt:new Date(now-30*day).toISOString()}],['defender off',{...healthy.security.defender,enabled:false}],['defender rtp off',{...healthy.security.defender,realTimeProtection:false}],['signatures 7 days',{...healthy.security.defender,signatureAt:new Date(now-7*day).toISOString()}],['signatures 7 days + 1 ms',{...healthy.security.defender,signatureAt:new Date(now-7*day-1).toISOString()}],['signatures missing',{...healthy.security.defender,signatureAt:''}]])fixtures.push([label,device({security:{...healthy.security,defender}})]);
fixtures.push(['updates with checkedAt',device({updates:{checkedAt:new Date(now-day).toISOString(),pendingCount:3,items:[]}})],['one update',device({updates:{checkedAt:new Date(now-day).toISOString(),pendingCount:1,items:[]}})],['updates without checkedAt',device({updates:{checkedAt:'',pendingCount:3,items:[]}})]);
fixtures.push(['collection errors',device({collectionErrors:['WMI timed out','Event log unavailable']})]);
const everything={cpu:95,memory:85,rebootPending:true,rebootReasons:['windows-servicing'],disks:[{name:'C:',label:'System',totalGb:100,freeGb:3},{name:'D:',label:'Data',totalGb:500,freeGb:50}],
 performance:{...healthy.performance,diskLatencyMs:120,pagefilePercent:82,processorQueue:20},security:{...healthy.security,firewall:[{name:'Public',enabled:false}],defender:{available:true,enabled:false,realTimeProtection:false,signatureAt:new Date(now-10*day).toISOString()}},
 updates:{checkedAt:new Date(now-day).toISOString(),pendingCount:4,items:[]},collectionErrors:['Partial inventory']};
fixtures.push(['everything online',device(everything)],['everything offline',device(everything,{lastSeen:now-600000})]);

let checks=0;
const evaluated=server=>({...server,issues:evaluateAlertRules(server,defaultAlertSettings(),now).filter(issue=>issue.ruleId!=='device-offline')});
for(const [label,server] of fixtures)for(const locale of ['en','de']){
 assert.deepEqual(deviceIssues(evaluated(server),now,locale),oldDeviceIssues(server,now,locale),`${label} (${locale})`);checks++;
}
// The six health signal rules stay silent on every fixture without their fields (older agents).
const healthRules=['crash-recent','os-support-end','os-support-unknown','bitlocker-system-unencrypted','bitlocker-suspended','bitlocker-no-recovery-password'];
for(const [label,server] of fixtures){assert.deepEqual(evaluateAlertRules(server,defaultAlertSettings(),now).filter(issue=>healthRules.includes(issue.ruleId)),[],`${label}: no health signal issue`);checks++;}
// The fixture with everything really exercises every rule.
assert.deepEqual(evaluateAlertRules(device(everything),defaultAlertSettings(),now).map(issue=>issue.key).sort(),['collection','cpu','defender','disk-C:','disk-D:','firewall','latency','memory','pagefile','queue','reboot','signatures','updates'].sort());checks++;
assert.equal(evaluateAlertRules(device(null),defaultAlertSettings(),now).length,0,'without a snapshot the server sends no issues');checks++;
assert.deepEqual(evaluateAlertRules({lastSeen:now,snapshot:{cpu:95}},defaultAlertSettings(),now).map(issue=>issue.key),['cpu'],'a partial snapshot without lists does not throw');checks++;

// a device that goes offline between two polls loses its live issues, the others stay.
{
 const polled=evaluated(device(everything)),later=now+180000;
 const shown=deviceIssues(polled,later,'en').map(issue=>issue.key);
 for(const key of ['cpu','memory','latency','pagefile','queue'])assert.ok(!shown.includes(key),`live issue ${key} is dropped once offline`);
 for(const key of ['disk-C:','disk-D:','reboot','firewall','defender','signatures','updates','collection'])assert.ok(shown.includes(key),`issue ${key} stays while offline`);
 assert.deepEqual(deviceIssues(polled,later,'de'),oldDeviceIssues(device(everything),now,'de').filter(issue=>shown.includes(issue.key)),'offline: the remaining issues keep their text and order');
 assert.ok(polled.issues.filter(issue=>issue.live).every(issue=>['cpu','memory','disk-latency','pagefile','processor-queue'].includes(issue.ruleId)),'exactly the live rules carry live:true');
 assert.deepEqual(deviceIssues({...polled,issues:undefined},now,'en'),[],'a device without issues shows none');
 checks+=16;
}
// the signatures title names the threshold of the level that fired (plural form).
{
 const settings=defaultAlertSettings();settings['signatures-age']={enabled:true,warning:1,critical:3,level:null};
 const make=age=>({...device({security:{...healthy.security,defender:{...healthy.security.defender,signatureAt:new Date(now-age).toISOString()}}})});
 const title=(age,locale)=>deviceIssues({...make(age),issues:evaluateAlertRules(make(age),settings,now)},now,locale).find(issue=>issue.key==='signatures')?.title;
 assert.equal(title(2*day,'en'),'Signatures older than 1 day');
 assert.equal(title(4*day,'en'),'Signatures older than 3 days');
 assert.equal(title(2*day,'de'),'Signaturen älter als 1 Tag');
 assert.equal(title(4*day,'de'),'Signaturen älter als 3 Tage');
 assert.equal(deviceIssues({...make(4*day),issues:evaluateAlertRules(make(4*day),settings,now)},now,'en').find(issue=>issue.key==='signatures').level,'critical');
 assert.equal(deviceIssues(evaluated(make(8*day)),now,'en').find(issue=>issue.key==='signatures').title,'Signatures older than 7 days','the default text is unchanged');
 checks+=6;
}
// Device offline: an issue from 15 minutes without a Heartbeat, none at 14, none while waiting for the first Heartbeat, dropped once online.
{
 const offline=minutes=>device({},{lastSeen:now-minutes*60000});
 const issues=server=>evaluateAlertRules(server,defaultAlertSettings(),now).filter(issue=>issue.ruleId==='device-offline');
 assert.deepEqual(issues(offline(15)),[{key:'offline',ruleId:'device-offline',level:'critical',live:false,params:{lastSeen:now-15*60000,minutes:15}}],'15 minutes: critical issue');
 assert.deepEqual(issues(offline(14)),[],'14 minutes: none');
 assert.deepEqual(issues(device({},{lastSeen:null})),[],'waiting for the first Heartbeat: none');
 assert.deepEqual(issues(device({},{lastSeen:now-60*60000,maintenance:{state:'updating',version:'4.1.0',notBefore:now}})),[],'agent update running: none');
 assert.deepEqual(issues(device(null,{lastSeen:now-20*60000})).map(issue=>issue.minutes??issue.params.minutes),[20],'also without a snapshot');
 const polled={...offline(15),issues:evaluateAlertRules(offline(15),defaultAlertSettings(),now)};
 assert.deepEqual(deviceIssues(polled,now,'en').find(issue=>issue.key==='offline'),{key:'offline',title:'Device offline',detail:'Last Heartbeat 15 min ago.',level:'critical'},'formatted (en)');
 assert.equal(deviceIssues(polled,now,'de').find(issue=>issue.key==='offline').title,'Gerät offline','formatted (de)');
 assert.equal(deviceIssues({...polled,lastSeen:now},now,'en').some(issue=>issue.key==='offline'),false,'dropped once the device is online at now');
 checks+=8;
}
console.log(`PASS alert rule parity (${checks} checks): ${fixtures.length} fixtures in English and German match the former deviceIssues; live issues drop when offline; signature age uses the threshold that fired; Device offline from 15 minutes.`);
