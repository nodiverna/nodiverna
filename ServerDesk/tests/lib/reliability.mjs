// Reliability (docs/device-health-signals.md#reliability): the strict snapshot
// schema, programSummary and fleetReliability (lib/reliability.ts), the rules
// stability-low and app-crash-repeated with their boundaries, and the issue texts
// in English and German. No database.
import '../support/register.mjs';
import assert from 'node:assert/strict';
const {telemetry,reliabilityState}=await import('../../lib/server/agent/telemetry.ts');
const {defaultAlertSettings,evaluateAlertRules}=await import('../../lib/alert-rules.ts');
const {deviceIssues}=await import('../../ui/base/ui-device.ts');
const {programSummary,fleetReliability}=await import('../../lib/reliability.ts');
const {translate}=await import('../../lib/i18n/translate.ts');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};

const now=Date.parse('2026-10-20T12:00:00.000Z'),day=86400000,hour=3600000,iso=offset=>new Date(now-offset).toISOString();
const base={hostname:'H',os:'Windows 11 Pro',build:'26100',manufacturer:'',model:'',domain:'',cores:4,memoryGb:16,cpu:5,memory:30,uptimeSeconds:10,rebootPending:false,management:false,disks:[],services:[],processes:[],events:[],networks:[],hotfixes:[],collectionErrors:[],protocolVersion:3,agentVersion:'4.11.0',mode:'ReadOnly',publicKey:{kty:'RSA',n:'a'.repeat(342),e:'AQAB'},agentCapabilities:[]};
const event=(program,kind,offset,extra={})=>({at:iso(offset),kind,program,version:'16.0.1',module:kind==='crash'?'ntdll.dll':null,moduleVersion:kind==='crash'?'10.0.26100.1':null,...extra});
const stable=(current,days=[])=>({available:true,current,days});
const state=(stability,events=[],extra={})=>({collectedAt:iso(0),windowDays:30,stability,events,truncated:false,...extra});

// ---- Schema ----
const good=state(stable(6.2,[{day:'2026-10-19',index:6.4},{day:'2026-10-20',index:6.2}]),[event('OUTLOOK.EXE','crash',hour),event('Teams.exe','hang',2*hour),event('Contoso Tools','install-failure',3*hour,{module:null,moduleVersion:null})]);
check(telemetry.safeParse({...base,reliability:good}).success,true,'a valid state');
check(reliabilityState.safeParse(state({available:false,reason:'collection-disabled'},[event('OUTLOOK.EXE','crash',hour)])).success,true,'collection disabled still carries crashes');
check(telemetry.safeParse({...base,agentVersion:'4.10.1'}).success,true,'a 4.10.x snapshot without reliability stays valid');
for(const [label,value] of [
 ['an unknown key',{...good,score:3}],
 ['a value next to a missing stability',state({available:false,reason:'collection-disabled',current:4})],
 ['an unknown reason',state({available:false,reason:'off'})],
 ['an index above 10',state(stable(10.5))],
 ['an index below 1',state(stable(0.5))],
 ['a window other than 30 days',{...good,windowDays:7}],
 ['an unknown kind',state(stable(5),[event('a.exe','freeze',hour)])],
 ['a program with a path',state(stable(5),[event('C:\\Program Files\\a.exe','crash',hour)])],
 ['a module with a path',state(stable(5),[event('a.exe','crash',hour,{module:'C:\\Windows\\ntdll.dll'})])],
 ['more than 100 events',state(stable(5),Array.from({length:101},(_,index)=>event('a.exe','crash',index*1000)))],
 ['more than 30 days',state(stable(5,Array.from({length:31},(_,index)=>({day:`2026-09-${String(index%30+1).padStart(2,'0')}`,index:5}))))],
])check(reliabilityState.safeParse(value).success,false,`rejects ${label}`);

// ---- programSummary ----
const outlook=[1,2,3,4,5].map(index=>event(index%2?'OUTLOOK.EXE':'Outlook.exe','crash',index*day-hour));
const summary=programSummary([...outlook,event('outlook.exe','hang',hour),event('outlook.exe','hang',2*hour),event('Teams.exe','crash',hour),event('Teams.exe','hang',hour),event('Contoso Tools','install-failure',hour),event('old.exe','crash',40*day)],now,30);
check(summary.map(row=>[row.program,row.crashes,row.hangs,row.installFailures]),[['OUTLOOK.EXE',5,2,0],['Teams.exe',1,1,0],['Contoso Tools',0,0,1]],'grouped case-insensitively, most frequent spelling, crashes first, older events dropped');
check(summary[0].last,iso(hour),'the last time of the program');
check(summary[0].events.length,7,'the single events of the program');
check(translate('en','reliability.summary',{program:summary[0].program,count:summary[0].crashes,days:7}),'OUTLOOK.EXE: 5 crashes in 7 days','the summary line');
check(translate('de','reliability.summary',{program:'Outlook.exe',count:1,days:7}),'Outlook.exe: 1 Absturz in 7 Tagen','the summary line (de)');
check(programSummary([event('a.exe','hang',hour),event('a.exe','hang',2*hour)],now,30).map(row=>[row.crashes,row.hangs]),[[0,2]],'hangs are not counted as crashes');

// ---- Rules ----
const issues=(reliability,settings=defaultAlertSettings())=>evaluateAlertRules({lastSeen:now,snapshot:{...base,reliability}},settings,now).filter(issue=>issue.ruleId==='stability-low'||issue.ruleId==='app-crash-repeated');
const keys=reliability=>issues(reliability).map(issue=>`${issue.key}:${issue.level}`);
const crashes=(count,offset=hour,program='OUTLOOK.EXE')=>Array.from({length:count},(_,index)=>event(program,'crash',offset+index*1000));
check(keys(state(stable(8),crashes(2))),[],'2 crashes in 7 days: no issue');
check(keys(state(stable(8),crashes(3))),['app-crash-outlook.exe:warning'],'3 crashes in 7 days: warning');
check(issues(state(stable(8),crashes(3)))[0].params,{program:'OUTLOOK.EXE',count:3,days:7},'params program, count and days');
check(keys(state(stable(8),[...crashes(2),event('OUTLOOK.EXE','crash',7*day+hour)])),[],'a crash older than 7 days does not count');
check(keys(state(stable(8),[...crashes(2),event('OUTLOOK.EXE','crash',7*day-hour)])),['app-crash-outlook.exe:warning'],'a crash just inside 7 days counts');
check(keys(state(stable(8),[...crashes(2),event('OUTLOOK.EXE','hang',hour)])),[],'a hang does not count');
check(keys(state(stable(8),[...crashes(3),...crashes(4,hour,'Teams.exe')])).sort(),['app-crash-outlook.exe:warning','app-crash-teams.exe:warning'],'one issue per program');
check(issues(state(stable(8),crashes(5)),{...defaultAlertSettings(),'app-crash-repeated':{enabled:true,warning:3,critical:5,level:null,durationMinutes:0,recovery:0}})[0].level,'critical','a critical step from an override');
check(keys(state(stable(5.0))),[],'stability 5.0: no issue');
check(keys(state(stable(4.9))),['stability:warning'],'stability 4.9: warning');
check(issues(state(stable(3.8)))[0].params,{index:3.8},'params index');
check(keys(state({available:false,reason:'collection-disabled'},crashes(2))),[],'not available: no stability issue');
check(keys(state({available:false,reason:'collection-disabled'},crashes(3))),['app-crash-outlook.exe:warning'],'crashes still count without stability data');
check(keys(undefined),[],'an older agent: no issue');
check(issues(state(stable(2)),{...defaultAlertSettings(),'stability-low':{enabled:false,warning:5,critical:null,level:null,durationMinutes:0,recovery:0}}),[],'a disabled rule');

// ---- fleetReliability ----
const device=(id,reliability)=>({id,snapshot:reliability===undefined?{...base}:{...base,reliability}});
const fleet=fleetReliability([
 device('a',state(stable(3.8),[...crashes(3),event('Teams.exe','hang',hour)])),
 device('b',state({available:false,reason:'collection-disabled'},[...crashes(2),event('OUTLOOK.EXE','crash',20*day)])),
 device('c',state(stable(9),[event('OUTLOOK.EXE','crash',40*day)])),
 device('d'),
],now);
check([fleet.lowStability,fleet.noStability],[1,2],'one device below 5, two without stability data (collection off and older agent)');
check(fleet.rows.map(row=>[row.program,row.crashes,row.hangs,row.devices]),[['OUTLOOK.EXE',6,0,2],['Teams.exe',0,1,1]],'per program: crashes and hangs of 30 days, devices');
check(fleet.rows[0].perDevice.map(row=>[row.id,row.crashes]).sort(),[['a',3],['b',3]],'the devices of a program with their counts');

// ---- Issue texts ----
const evaluated=reliability=>{const server={id:'d',name:'D',createdAt:0,revoked:0,management:0,lastSeen:now,snapshot:{...base,reliability}};return {...server,issues:evaluateAlertRules(server,defaultAlertSettings(),now)};};
const texts=(reliability,locale)=>deviceIssues(evaluated(reliability),now,locale).map(item=>[item.title,item.detail]);
check(texts(state(stable(3.8),crashes(5)),'en'),[['Low stability index','Stability index 3.8 of 10.'],['OUTLOOK.EXE crashes repeatedly','5 crashes in 7 days.']],'texts (en)');
check(texts(state(stable(3.8),crashes(5)),'de'),[['Niedriger Stabilitätsindex','Stabilitätsindex 3,8 von 10.'],['OUTLOOK.EXE stürzt wiederholt ab','5 Abstürze in 7 Tagen.']],'texts (de)');

console.log(`PASS reliability (${checks} checks): strict schema, programSummary and fleetReliability, stability-low at 5.0/4.9 and not available, app-crash-repeated at 2/3 crashes and the 7-day boundary, issue texts in English and German.`);
