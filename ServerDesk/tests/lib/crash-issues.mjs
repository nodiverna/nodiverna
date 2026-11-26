// Crashes (docs/device-health-signals.md): the telemetry schema, the rule
// crash-recent at its boundaries and with overridden thresholds, the summary per
// driver, the stop code helpers, the issue texts in English and German, the
// fleet filter and the console boundary for crash data. No database.
import '../support/register.mjs';
import assert from 'node:assert/strict';
const {telemetry,crashEntries}=await import('../../lib/server/agent/telemetry.ts');
const {defaultAlertSettings,evaluateAlertRules}=await import('../../lib/alert-rules.ts');
const {deviceIssues}=await import('../../ui/base/ui-device.ts');
const {bugCheckName,bugCheckNameCount,formatStopCode,bugCheckDocUrl,bugCheckReferenceUrl}=await import('../../ui/base/bugcheck-codes.ts');
const {fleetFilterMatch}=await import('../../ui/devices/fleet/fleet-filters.ts');
const {recentCrashes}=await import('../../ui/devices/inventory/health-signals.ts');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};

const now=Date.parse('2026-10-20T12:00:00.000Z'),day=86400000,iso=offset=>new Date(now-offset).toISOString();
const parameters=['0x00000000c0000005','0xfffff80410001234','0xffffd00012345678','0x0000000000000000'];
const crash=(offset,overrides={})=>({id:'a1b2c3d4e5f60718',kind:'bugcheck',at:iso(offset),stopCode:0x3B,parameters,driver:{name:'vjoy.sys',version:'2.1.9.1',manufacturer:'Shaul Eizikovich'},source:'event+minidump',dumpFile:'102026-12000-01.dmp',dumpStatus:'parsed',detail:null,...overrides});
const inventory={collectedAt:iso(0),windowDays:30,complete:true,truncated:false};

// ---- Telemetry schema ----
const base={hostname:'H',os:'Windows 11 Pro',build:'26100',manufacturer:'',model:'',domain:'',cores:4,memoryGb:16,cpu:5,memory:30,uptimeSeconds:10,rebootPending:false,management:false,disks:[],services:[],processes:[],events:[],networks:[],hotfixes:[],collectionErrors:[],protocolVersion:3,agentVersion:'4.10.0',mode:'ReadOnly',publicKey:{kty:'RSA',n:'a'.repeat(342),e:'AQAB'},agentCapabilities:[]};
check(telemetry.safeParse({...base,crashes:[crash(day)],crashInventory:inventory}).success,true,'valid crashes and inventory');
check(telemetry.safeParse(base).success,true,'a 4.9.x snapshot without crash fields stays valid');
check(crashEntries.safeParse([crash(day,{kind:'unexpected-shutdown',stopCode:null,parameters:null,driver:null,source:'event',dumpFile:null,dumpStatus:'none'})]).success,true,'an unexpected shutdown without code, driver and dump');
for(const [label,value] of [
 ['an unknown key',[{...crash(day),memory:'dump bytes'}]],
 ['an unknown driver key',[crash(day,{driver:{name:'a.sys',version:null,manufacturer:null,path:'C:\\Windows'}})]],
 ['more than 50 entries',Array.from({length:51},()=>crash(day))],
 ['a parameter that is no hex',[crash(day,{parameters:['0xZZ','0x1','0x2','0x3']})]],
 ['three parameters',[crash(day,{parameters:parameters.slice(0,3)})]],
 ['an unknown kind',[crash(day,{kind:'freeze'})]],
 ['a date that is no ISO date',[crash(day,{at:'gestern'})]],
 ['a dump path instead of a file name',[crash(day,{dumpFile:'C:\\Windows\\Minidump\\a.dmp'})]],
 ['a detail longer than 256 characters',[crash(day,{detail:'x'.repeat(257)})]],
 ['a stop code beyond 32 bits',[crash(day,{stopCode:2**32})]],
])check(telemetry.safeParse({...base,crashes:value,crashInventory:inventory}).success,false,`rejects ${label}`);
check(telemetry.safeParse({...base,crashInventory:{...inventory,windowDays:7}}).success,false,'windowDays is always 30');
check(telemetry.safeParse({...base,crashInventory:{...inventory,extra:1}}).success,false,'the inventory is strict');

// ---- crash-recent at its boundaries ----
const device=(crashes,extra={})=>({lastSeen:now,snapshot:{...base,crashes,crashInventory:inventory},...extra});
const level=(crashes,settings=defaultAlertSettings())=>evaluateAlertRules(device(crashes),settings,now).find(issue=>issue.ruleId==='crash-recent')?.level??null;
check(level([crash(7*day)]),'critical','exactly 7 days: critical');
check(level([crash(7*day+1)]),'warning','7 days + 1 ms: warning');
check(level([crash(30*day)]),'warning','exactly 30 days: warning');
check(level([crash(30*day+1)]),null,'30 days + 1 ms: none');
check(level([crash(40*day),crash(2*day,{kind:'hardware-error',stopCode:null,driver:null})]),'critical','the newest crash decides');
check(evaluateAlertRules({lastSeen:now,snapshot:base},defaultAlertSettings(),now).some(issue=>issue.ruleId==='crash-recent'),false,'an older agent without crashes: no issue');
check(evaluateAlertRules({lastSeen:now-day,snapshot:{...base,crashes:[crash(day)]}},defaultAlertSettings(),now).find(issue=>issue.ruleId==='crash-recent')?.live,false,'the rule is not live: it stays for an offline device');
const custom={...defaultAlertSettings(),'crash-recent':{enabled:true,warning:14,critical:3,level:null}};
check([level([crash(3*day)],custom),level([crash(10*day)],custom),level([crash(20*day)],custom)],['critical','warning',null],'overridden thresholds 14/3');
check(level([crash(day)],{...defaultAlertSettings(),'crash-recent':{enabled:false,warning:30,critical:7,level:null}}),null,'a disabled rule');
check(level([crash(day)],{...defaultAlertSettings(),'crash-recent':{enabled:true,warning:30,critical:null,level:null}}),'warning','warning step only');

// ---- Summary per driver ----
const issue=crashes=>evaluateAlertRules(device(crashes),defaultAlertSettings(),now).find(item=>item.ruleId==='crash-recent');
check(issue([crash(day),crash(6*day,{driver:{name:'VJOY.SYS',version:null,manufacturer:null}}),crash(13*day+5*3600000)]).params,{at:iso(day),kind:'bugcheck',stopCode:0x3B,driver:'vjoy.sys',sameDriverCount:3,sameDriverDays:14},'3 × vjoy.sys (case-insensitive) within 14 days, rounded up');
check(issue([crash(day),crash(3*day,{driver:{name:'nvlddmkm.sys',version:null,manufacturer:null}})]).params.sameDriverCount,undefined,'mixed drivers: no summary');
check(issue([crash(day),crash(40*day)]).params.sameDriverCount,undefined,'a second crash outside the warning window does not count');
check(issue([crash(day,{driver:null,kind:'unexpected-shutdown',stopCode:null})]).params,{at:iso(day),kind:'unexpected-shutdown'},'no driver: no driver params');

// ---- Stop codes ----
check(bugCheckNameCount>=40,true,'at least 40 named stop codes');
for(const code of [0x0A,0x1A,0x1E,0x3B,0x50,0x7E,0x7F,0x9F,0xA0,0xC2,0xD1,0xEF,0x116,0x119,0x124,0x133,0x139,0x154])check(typeof bugCheckName(code),'string',`0x${code.toString(16)} has a name`);
check([formatStopCode(0x3B),formatStopCode(0x124),formatStopCode(0xA),formatStopCode(0x1234ABCD)],['0x3B SYSTEM_SERVICE_EXCEPTION','0x124 WHEA_UNCORRECTABLE_ERROR','0xA IRQL_NOT_LESS_OR_EQUAL','0x1234ABCD'],'formatStopCode');
check(bugCheckDocUrl(0x3B),'https://learn.microsoft.com/windows-hardware/drivers/debugger/bug-check-0x3b--system-service-exception','doc link 0x3B');
check(bugCheckDocUrl(0x124),'https://learn.microsoft.com/windows-hardware/drivers/debugger/bug-check-0x124--whea-uncorrectable-error','doc link 0x124');
check(bugCheckDocUrl(0xA),'https://learn.microsoft.com/windows-hardware/drivers/debugger/bug-check-0xa--irql-not-less-or-equal','doc link 0xA');
check([bugCheckDocUrl(0x1234ABCD),bugCheckName(0x1234ABCD)],[bugCheckReferenceUrl,null],'an unknown code links the code reference');

// ---- Issue texts ----
const evaluated=crashes=>({...device(crashes),id:'d',name:'D',createdAt:0,revoked:0,management:0,issues:evaluateAlertRules(device(crashes),defaultAlertSettings(),now)});
const text=(crashes,locale)=>deviceIssues(evaluated(crashes),now,locale).find(item=>item.key==='crash');
const single=[crash(2*day,{driver:null})],time=en=>new Date(iso(2*day)).toLocaleString(en?'en-US':'de-DE');
check(text(single,'en'),{key:'crash',title:'Blue screen 0x3B SYSTEM_SERVICE_EXCEPTION',detail:`On ${time(true)}.`,level:'critical'},'bugcheck (en)');
check(text(single,'de'),{key:'crash',title:'Bluescreen 0x3B SYSTEM_SERVICE_EXCEPTION',detail:`Am ${time(false)}.`,level:'critical'},'bugcheck (de)');
check(text([crash(2*day)],'en').detail,`On ${time(true)}, caused by vjoy.sys.`,'detail with the driver (en)');
check(text([crash(2*day)],'de').detail,`Am ${time(false)}, verursacht durch vjoy.sys.`,'detail with the driver (de)');
check(text([crash(2*day,{kind:'unexpected-shutdown',stopCode:null,driver:null})],'en').title,'Unexpected shutdown','shutdown (en)');
check(text([crash(2*day,{kind:'hardware-error',stopCode:null,driver:null})],'de').title,'Hardwarefehler (WHEA)','hardware error (de)');
const repeated=[crash(day),crash(6*day),crash(13*day+3600000)];
check(text(repeated,'en').title,'3 crashes caused by vjoy.sys in 14 days','driver summary (en)');
check(text(repeated,'de').title,'3 Abstürze durch vjoy.sys in 14 Tagen','driver summary (de)');
check(text([crash(day),crash(day/2)],'en').title,'2 crashes caused by vjoy.sys in 1 day','one day in the singular');

// ---- Fleet filter: fixed 30 days ----
const server=crashes=>({snapshot:{...base,crashes}});
check([fleetFilterMatch(server([crash(29*day)]),'crashes',now),fleetFilterMatch(server([crash(31*day)]),'crashes',now),fleetFilterMatch(server(undefined),'crashes',now),fleetFilterMatch({snapshot:null},'crashes',now)],[true,false,false,false],'crashes within 30 days, whatever the rule');
check(recentCrashes(server([crash(day),crash(31*day)]),now).length,1,'recentCrashes keeps the last 30 days');

// ---- Console boundary: crash data only on the devices the viewer sees ----
const route=(await import('node:fs')).readFileSync('app/api/console/route.ts','utf8');
check(/visible\.length\?consoleDevices\(scope\)/.test(route)&&/WHERE s\.revoked=0 AND s\.id IN \(SELECT value FROM jsonb_array_elements_text\(\$\{scope\}::jsonb\)\)/.test((await import('node:fs')).readFileSync('lib/server/console-data.ts','utf8')),true,'the console reads snapshots (and their crashes) only for the visible device IDs');

console.log(`PASS crash issues (${checks} checks): schema, rule boundaries and overrides, driver summary, stop codes, issue texts in English and German, fleet filter and console boundary.`);
