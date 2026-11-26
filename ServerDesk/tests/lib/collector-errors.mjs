// Collector errors of agent 4.11.1 (docs/v3-health-signals.md, "Collector errors in
// 4.11.1"): the heartbeat schema accepts the optional, strict collectorErrors list
// and still accepts a 4.11.0 snapshot without it, collectorError() finds an entry,
// and every reason key of the Drivers area exists in both catalogs. No database.
import '../support/register.mjs';
import assert from 'node:assert/strict';
const {telemetry,collectorErrorCodes}=await import('../../lib/server/agent/telemetry.ts');
const {collectorError}=await import('../../ui/devices/inventory/health-signals.ts');
const {default:en}=await import('../../lib/i18n/messages/en.ts');
const {default:de}=await import('../../lib/i18n/messages/de.ts');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};

const base={hostname:'H',os:'Windows 11 Pro',build:'26100',manufacturer:'',model:'',domain:'',cores:4,memoryGb:16,cpu:5,memory:30,uptimeSeconds:10,rebootPending:false,management:false,disks:[],services:[],processes:[],events:[],networks:[],hotfixes:[],collectionErrors:['Drivers could not be read (BrokerException).'],protocolVersion:3,agentVersion:'4.11.1',mode:'ReadOnly',publicKey:{kty:'RSA',n:'a'.repeat(342),e:'AQAB'},agentCapabilities:[]};
const entry=(overrides={})=>({collector:'drivers',code:'timeout',since:'2026-11-03T16:13:25.6294456+00:00',lastAt:'2026-11-03T16:28:26.0000000+00:00',failures:2,elapsedMs:15012,...overrides});
const valid=value=>telemetry.safeParse(value).success;

// ---- Schema ----
check(valid({...base,collectorErrors:[entry(),entry({collector:'disk-and-battery-health',code:'access-denied',failures:1,elapsedMs:null})]}),true,'a 4.11.1 snapshot with collectorErrors');
check(valid({...base,collectorErrors:[]}),true,'an empty list');
check(valid({...base,agentVersion:'4.11.0'}),true,'a 4.11.0 snapshot without the field');
for(const code of collectorErrorCodes)check(valid({...base,collectorErrors:[entry({code})]}),true,`the code ${code}`);
check(collectorErrorCodes,['timeout','access-denied','not-supported','broker-unavailable','error'],'the five codes');
for(const [label,value] of [
 ['an unknown key',[{...entry(),message:'Zeitüberschreitung'}]],
 ['an unknown code',[entry({code:'crashed'})]],
 ['31 entries',Array.from({length:31},(_,i)=>entry({collector:`collector-${i}`}))],
 ['a bad id (upper case)',[entry({collector:'Drivers'})]],
 ['a bad id (space)',[entry({collector:'software inventory'})]],
 ['a bad id (too long)',[entry({collector:'a'.repeat(49)})]],
 ['failures 0',[entry({failures:0})]],
 ['failures above 1,000,000',[entry({failures:1_000_001})]],
 ['a fractional failure count',[entry({failures:1.5})]],
 ['a negative elapsed time',[entry({elapsedMs:-1})]],
 ['an elapsed time above one hour',[entry({elapsedMs:3_600_001})]],
 ['a date that is not ISO',[entry({since:'yesterday'})]],
 ['a missing lastAt',[{...entry(),lastAt:undefined}]],
])check(valid({...base,collectorErrors:value}),false,`rejects ${label}`);
check(valid({...base,collectorErrors:Array.from({length:30},(_,i)=>entry({collector:`collector-${i}`}))}),true,'30 entries');

// ---- collectorError() ----
const snapshot={...base,collectorErrors:[entry({collector:'software-inventory',code:'error'}),entry()]};
check(collectorError(snapshot,'drivers')?.code,'timeout','finds the drivers entry');
check(collectorError(snapshot,'certificates'),null,'null for a collector without an error');
check(collectorError({...base},'drivers'),null,'null without the field');
check(collectorError(null,'drivers'),null,'null without a snapshot');

// ---- Catalogs ----
for(const key of ['drivers.unavailable.title','drivers.unavailable.since','drivers.unavailable.stale','drivers.notReportedYet',...['timeout','accessDenied','notSupported','brokerUnavailable','error'].map(name=>`drivers.unavailable.reason.${name}`)]){
 check(typeof en[key],'string',`en has ${key}`);
 check(typeof de[key],'string',`de has ${key}`);
}
check(de['drivers.unavailable.since'].includes('{time}')&&en['drivers.unavailable.stale'].includes('{time}'),true,'the time placeholders');

console.log(`PASS collector errors (${checks} checks): optional strict collectorErrors in the heartbeat schema, 4.11.0 snapshots stay valid, collectorError() and the reason texts in both catalogs.`);
