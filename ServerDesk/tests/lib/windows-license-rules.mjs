// The two Windows activation rules of agent 4.22.0 in evaluateAlertRules and
// alertReadings (lib/alert-rules.ts): an evaluation with 47 days left warns with
// its params, 10 days and an ended evaluation are critical, an unknown end warns
// only with a warning step, the rule off makes no issue; a missing or unavailable
// license is silent; not activated warns with the grace date; licensed retail
// makes none; an offline device still reports both. The evaluation reading exists
// only for a running or ended evaluation. No database.
import '../support/register.mjs';
import assert from 'node:assert/strict';
const {alertReadings,defaultAlertSettings,evaluateAlertRules}=await import('../../lib/alert-rules.ts');

let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const day=86400000,now=Date.UTC(2026,10,26,10,0,0),iso=offset=>new Date(now+offset).toISOString();
const license=(values={})=>({available:true,collectedAt:iso(-60_000),status:'licensed',channel:'evaluation',expiresAt:iso(47*day),evaluationEndsAt:null,...values});
const device=(windowsLicense,extra={},lastSeen=now-10_000)=>({lastSeen,snapshot:{os:'Microsoft Windows Server 2025 Standard Evaluation',osInfo:{editionId:'ServerStandardEval',installationType:'Server',displayVersion:'24H2',ubr:1,productName:'Windows Server 2025 Standard Evaluation',currentBuild:'26100'},...(windowsLicense===undefined?{}:{windowsLicense}),...extra}});
const issues=(server,settings=defaultAlertSettings())=>evaluateAlertRules(server,settings,now).filter(issue=>issue.ruleId==='windows-evaluation'||issue.ruleId==='windows-not-activated');
const product='Windows Server 2025 Standard Evaluation';

// ---- windows-evaluation with the default settings (warning 180, critical 14) ----
check(issues(device(license())),[{key:'windows-evaluation',ruleId:'windows-evaluation',level:'warning',live:false,params:{product,date:iso(47*day),daysLeft:47,ended:'false'}}],"the owner's case: one warning with 47 days left");
check(issues(device(license({expiresAt:iso(10*day)}))).map(issue=>[issue.level,issue.params.daysLeft]),[['critical',10]],'10 days left is critical');
check(issues(device(license({expiresAt:iso(14*day)}))).map(issue=>issue.level),['critical'],'14 days left is critical');
check(issues(device(license({expiresAt:iso(-2*day)}))).map(issue=>[issue.level,issue.params]),[['critical',{product,date:iso(-2*day),daysLeft:-2,ended:'true'}]],'ended with a date is critical');
check(issues(device(license({status:'notification',expiresAt:null}))).map(issue=>[issue.ruleId,issue.level,issue.params]),[['windows-evaluation','critical',{product,date:null,daysLeft:0,ended:'true'}],['windows-not-activated','warning',{status:'notification',channel:'evaluation',date:null,daysLeft:null}]],'an evaluation in notification mode has ended and is not activated');
check(issues(device(license({expiresAt:null}))),[{key:'windows-evaluation',ruleId:'windows-evaluation',level:'warning',live:false,params:{product,date:null,daysLeft:null,ended:'false'}}],'an unknown end warns');
const criticalOnly=defaultAlertSettings();criticalOnly['windows-evaluation']={...criticalOnly['windows-evaluation'],warning:null,critical:14};
check(issues(device(license({expiresAt:null})),criticalOnly),[],'an unknown end with only a critical step makes no issue');
check(issues(device(license({expiresAt:iso(200*day)}))),[],'more than 180 days left makes no issue');
const off=defaultAlertSettings();off['windows-evaluation']={...off['windows-evaluation'],enabled:false};off['windows-not-activated']={...off['windows-not-activated'],enabled:false};
check(issues(device(license({expiresAt:iso(-2*day),status:'notification'})),off),[],'both rules off make no issue');
const strict=defaultAlertSettings();strict['windows-evaluation']={...strict['windows-evaluation'],warning:null,critical:48};
check(issues(device(license()),strict).map(issue=>issue.level),['critical'],'a device override to critical at 48 days');
// The product falls back to snapshot.os without osInfo.productName.
check(issues({lastSeen:now,snapshot:{os:'Microsoft Windows Server 2022 Standard',windowsLicense:license()}})[0].params.product,'Microsoft Windows Server 2022 Standard','the product from snapshot.os');

// ---- Silent cases ----
check(issues(device(undefined)),[],'no windowsLicense (older agent)');
for(const reason of ['not-found','access-denied','error'])check(issues(device({available:false,reason,collectedAt:iso(0)})),[],`not available (${reason})`);
check(issues({lastSeen:now,snapshot:{os:'Microsoft Windows Server 2025 Standard',windowsLicense:license({channel:'retail',expiresAt:null})}}),[],'licensed retail makes none');

// ---- windows-not-activated ----
const retail=(values)=>({lastSeen:now,snapshot:{os:'Microsoft Windows 11 Pro',osInfo:{editionId:'Professional',installationType:'Client',displayVersion:'24H2',ubr:1,productName:'Windows 11 Pro',currentBuild:'26100'},windowsLicense:license({channel:'retail',expiresAt:null,...values})}});
check(issues(retail({status:'notification'})),[{key:'windows-not-activated',ruleId:'windows-not-activated',level:'warning',live:false,params:{status:'notification',channel:'retail',date:null,daysLeft:null}}],'notification warns without a date');
check(issues(retail({status:'initial-grace',expiresAt:iso(25*day)})).map(issue=>issue.params),[{status:'initial-grace',channel:'retail',date:iso(25*day),daysLeft:25}],'initial-grace carries the grace date');
check(issues(retail({status:'unknown'})),[],'unknown makes no issue');
const critical=defaultAlertSettings();critical['windows-not-activated']={...critical['windows-not-activated'],level:'critical'};
check(issues(retail({status:'unlicensed'}),critical).map(issue=>issue.level),['critical'],'the level of the rule');

// ---- An offline device keeps both (not live) ----
const offline=device(license({status:'notification',expiresAt:null}),{},now-3*day);
check(issues(offline).map(issue=>[issue.ruleId,issue.live]),[['windows-evaluation',false],['windows-not-activated',false]],'offline: both rules still report');

// ---- alertReadings ----
const reading=server=>alertReadings(server,now).filter(item=>item.ruleId==='windows-evaluation');
check(reading(device(license())),[{ruleId:'windows-evaluation',key:'windows-evaluation',value:47}],'running: the days left');
check(reading(device(license({expiresAt:iso(-5*day)}))),[{ruleId:'windows-evaluation',key:'windows-evaluation',value:-5}],'ended: negative days for "N days overdue"');
check(reading(device(license({status:'notification',expiresAt:null}))),[{ruleId:'windows-evaluation',key:'windows-evaluation',value:0}],'ended without a date: 0');
check(reading(device(license({expiresAt:null}))),[],'unknown: no reading');
check(reading(retail({status:'notification'})),[],'no evaluation: no reading');
check(reading(device(undefined)),[],'not reported: no reading');

console.log(`PASS Windows license alert rules (${checks} checks): evaluation warning at 47 days, critical at 14 or less and once ended, unknown end at the warning step only, rule off, silent without or with an unavailable license, not activated with the grace date, offline devices, and the evaluation reading only for a running or ended evaluation.`);
