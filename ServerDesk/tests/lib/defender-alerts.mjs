// The Defender alert rules of agent 4.14.0 (lib/alert-rules.ts, docs/alert-rules.md):
// defender-off with passive, side-by-side and EDR block mode and with another
// enabled antivirus, the unchanged rule for older agents, threat-detected with
// only count and severity, scan-age with its threshold, without a scan and in
// passive mode, signatures-age from snapshot.defender, and the alarm state of a
// device that never reported a scan. No database.
import '../support/register.mjs';
import assert from 'node:assert/strict';
const {alertReadings,defaultAlertSettings,evaluateAlertRules}=await import('../../lib/alert-rules.ts');
const {alertTransitions}=await import('../../lib/server/devices/alert-state.ts');
const {issueText}=await import('../../ui/base/ui-device.ts');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};

const now=Date.parse('2026-11-04T12:00:00Z'),day=86400000,iso=offset=>new Date(now-offset).toISOString();
const settings=defaultAlertSettings();
const legacy={available:true,enabled:true,signatureAt:iso(day),realTimeProtection:true};
const security=defender=>({domainJoined:true,domainRole:3,rdpEnabled:false,firewall:[],defender,lastBoot:iso(day)});
const report=(extra={})=>({available:true,collectedAt:iso(60000),mode:'normal',antivirusEnabled:true,realTimeProtection:true,tamperProtected:true,quickScanAt:iso(day),fullScanAt:iso(10*day),signatureAt:iso(2*3600000),signatureVersion:'1.0',productVersion:'4.18',otherAntivirus:null,detectionCount:0,activeCount:0,highestActiveSeverity:null,truncated:false,detections:[],exclusions:null,...extra});
const device=(defender,legacyDefender=legacy)=>({snapshot:{cpu:1,memory:1,disks:[],cores:4,collectionErrors:[],security:security(legacyDefender),...(defender===undefined?{}:{defender})},lastSeen:now-10000,maintenance:undefined});
const issues=(server,own=settings)=>evaluateAlertRules(server,own,now);
const issue=(server,ruleId,own=settings)=>issues(server,own).find(item=>item.ruleId===ruleId);

// ---- defender-off ----
const off={antivirusEnabled:true,realTimeProtection:false};
for(const mode of ['passive','sxs-passive','edr-block'])check(issue(device(report({mode,...off})),'defender-off'),undefined,`${mode} does not fire defender-off`);
check(issue(device(report({...off,otherAntivirus:[{name:'Contoso Endpoint Security',enabled:true}]})),'defender-off'),undefined,'off next to an enabled other antivirus does not fire');
check(issue(device(report({...off,otherAntivirus:[{name:'Old AV',enabled:false}]})),'defender-off')?.level,'warning','off next to a disabled other antivirus fires');
check(issue(device(report(off)),'defender-off'),{key:'defender',ruleId:'defender-off',level:'warning',live:false,params:{}},'off without another antivirus fires');
check(issue(device(report({antivirusEnabled:false})),'defender-off')?.level,'warning','antivirus off fires');
check(issue(device(report()),'defender-off'),undefined,'an active Defender does not fire');
check(issue(device({available:false,reason:'not-installed',collectedAt:iso(60000)}),'defender-off'),undefined,'not installed does not fire');
check(issue(device(report(),{...legacy,realTimeProtection:false}),'defender-off'),undefined,'with snapshot.defender, security.defender no longer decides');
// Older agent: today's rule on security.defender.
check(issue(device(undefined,{...legacy,realTimeProtection:false}),'defender-off')?.level,'warning','older agent: real-time off fires');
check(issue(device(undefined,{...legacy,enabled:false}),'defender-off')?.level,'warning','older agent: antivirus off fires');
check(issue(device(undefined,{...legacy,available:false}),'defender-off'),undefined,'older agent: Defender not available does not fire');
check(issue(device(undefined),'defender-off'),undefined,'older agent: active does not fire');

// ---- threat-detected ----
const threat=report({detectionCount:3,activeCount:2,highestActiveSeverity:'severe',detections:[
 {id:'{A}',threatId:'1',name:'Trojan:Win32/Secret',severity:'severe',status:'detected',active:true,path:'C:\\Users\\anna\\secret.exe',resourceCount:1,at:iso(3600000),user:'CONTOSO\\anna'}]});
const fired=issue(device(threat),'threat-detected');
check(fired,{key:'threats',ruleId:'threat-detected',level:'critical',live:false,params:{count:2,severity:'severe'}},'threat-detected fires critical with count and severity only');
check(Object.keys(fired.params).sort(),['count','severity'],'no name, path or user in the params');
const serialized=JSON.stringify(issues(device(threat)));
for(const secret of ['Trojan','secret.exe','anna','CONTOSO'])check(serialized.includes(secret),false,`no issue carries ${secret}`);
check(issue(device(report()),'threat-detected'),undefined,'no active detection: no issue');
check(issue(device(undefined),'threat-detected'),undefined,'older agents do not fire it');
check(issue(device(threat),'threat-detected',{...settings,'threat-detected':{...settings['threat-detected'],level:'warning'}})?.level,'warning','the level follows the settings');
check(issue(device(threat),'threat-detected',{...settings,'threat-detected':{...settings['threat-detected'],enabled:false}}),undefined,'a disabled rule does not fire');
check(issueText(fired,'en',now),{title:'2 active Defender detections',detail:'Highest severity: Severe'},'issue text (en)');
check(issueText({ruleId:'threat-detected',params:{count:1,severity:'high'}},'de',now),{title:'1 aktiver Defender-Fund',detail:'Höchster Schweregrad: Hoch'},'issue text (de)');

// ---- scan-age ----
const scanAt=days=>report({quickScanAt:iso(days*day),fullScanAt:iso(40*day)});
check(issue(device(scanAt(6)),'scan-age'),undefined,'6 days with warning 7: no issue');
check(issue(device(scanAt(8)),'scan-age'),{key:'scan',ruleId:'scan-age',level:'warning',live:false,params:{scanAt:iso(8*day),threshold:7}},'8 days with warning 7: warning with scanAt and threshold');
check(issue(device(report({quickScanAt:iso(30*day),fullScanAt:iso(2*day)})),'scan-age'),undefined,'the newer of quick and full scan counts');
const critical={...settings,'scan-age':{...settings['scan-age'],warning:7,critical:14}};
check(issue(device(scanAt(20)),'scan-age',critical)?.level,'critical','20 days with critical 14: critical');
const never=device(report({quickScanAt:null,fullScanAt:null}));
check(issue(never,'scan-age'),{key:'scan',ruleId:'scan-age',level:'warning',live:false,params:{scanAt:null,threshold:7}},'never scanned fires at the highest set level');
check(issue(never,'scan-age',critical),{key:'scan',ruleId:'scan-age',level:'critical',live:false,params:{scanAt:null,threshold:14}},'never scanned with a critical step: critical');
check(alertReadings(never,now).filter(reading=>reading.ruleId==='scan-age'),[],'never scanned has no reading');
check(alertReadings(device(scanAt(8)),now).filter(reading=>reading.ruleId==='scan-age').map(reading=>[reading.key,Math.round(reading.value)]),[['scan',8]],'the reading is the age in days');
for(const mode of ['passive','sxs-passive','edr-block','not-running'])check(issue(device(report({mode,quickScanAt:null,fullScanAt:null})),'scan-age'),undefined,`${mode} does not fire scan-age`);
check(issue(device(undefined),'scan-age'),undefined,'older agents do not fire scan-age');
check(issueText({ruleId:'scan-age',params:{scanAt:'2026-10-27T12:00:00.000Z',threshold:7}},'en',now).title,'Defender scan older than 7 days','scan issue title');
check(issueText({ruleId:'scan-age',params:{scanAt:null,threshold:1}},'en',now),{title:'Defender scan older than 1 day',detail:'No scan reported'},'never scanned issue text');
check(issueText({ruleId:'scan-age',params:{scanAt:null,threshold:7}},'de',now),{title:'Defender-Scan älter als 7 Tage',detail:'Kein Scan gemeldet'},'German issue text');

// ---- signatures-age ----
const oldSignatures=report({signatureAt:iso(9*day)});
check(issue(device(oldSignatures,{...legacy,signatureAt:iso(day)}),'signatures-age')?.params,{signatureAt:iso(9*day),threshold:7},'signatures-age prefers defender.signatureAt');
check(issue(device(report({signatureAt:iso(day)}),{...legacy,signatureAt:iso(9*day)}),'signatures-age'),undefined,'a fresh defender.signatureAt wins over an old security.defender');
check(issue(device(undefined,{...legacy,signatureAt:iso(9*day)}),'signatures-age')?.level,'warning','older agents keep security.defender.signatureAt');
check(alertReadings(device(oldSignatures),now).filter(reading=>reading.ruleId==='signatures-age').map(reading=>Math.round(reading.value)),[9],'the reading follows defender.signatureAt');

// ---- Alarm state: a device that never reported a scan ----
const neverIssues=issues(never),neverReadings=alertReadings(never,now);
const first=alertTransitions({server:never,alerts:[],issues:neverIssues,readings:neverReadings,settings,now});
const insert=first.inserts.find(row=>row.ruleId==='scan-age');
check([insert?.state,insert?.level,insert?.peakValue,insert?.params],['open','warning',null,{scanAt:null,threshold:7}],'never scanned opens an alarm without a value');
const open={id:'a1',ruleId:'scan-age',key:'scan',state:'open',level:'warning',peakLevel:'warning',peakValue:null,threshold:7,params:{scanAt:null,threshold:7},startedAt:now-day,openedAt:now-day,acknowledgedAt:null};
const later=alertTransitions({server:never,alerts:[open],issues:neverIssues,readings:neverReadings,settings,now:now+3600000});
check([later.closes,later.updates,later.deletes],[[],[],[]],'the open alarm stays open and unchanged while the issue fires');
const scanned=device(scanAt(1));
const done=alertTransitions({server:scanned,alerts:[open],issues:issues(scanned),readings:alertReadings(scanned,now),settings,now});
check(done.closes,[{id:'a1',reason:'recovered'}],'a new scan closes it as recovered');

console.log(`PASS defender alerts (${checks} checks): defender-off ignores passive Defender and covered devices, older agents keep their rule, threat-detected carries only count and severity, scan-age with threshold, never-scanned and passive cases, signatures-age from snapshot.defender and the open alarm of a never-scanned device.`);
