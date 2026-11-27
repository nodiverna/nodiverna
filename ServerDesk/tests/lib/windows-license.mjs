// The pure Windows activation rules of agent 4.22.0 (lib/windows-license.ts):
// isEvaluation by channel and by the edition ID, evaluationEnd (running with the
// days left, the earlier of expiresAt and evaluationEndsAt, expiresAt ignored
// while not licensed, ended with and without a date, unknown, not an evaluation)
// and notActivated for every status. No database.
import '../support/register.mjs';
import assert from 'node:assert/strict';
const {isEvaluation,evaluationEnd,notActivated,graceEnd,daysLeftUntil}=await import('../../lib/windows-license.ts');
const {certificateDaysLeft}=await import('../../lib/alert-rules.ts');

let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const day=86400000,now=Date.UTC(2026,10,26,10,0,0),iso=offset=>new Date(now+offset).toISOString();
const license=(values={})=>({available:true,collectedAt:iso(-60_000),status:'licensed',channel:'retail',expiresAt:null,evaluationEndsAt:null,...values});
const server2025={editionId:'ServerStandard'},evalEdition={editionId:'ServerStandardEval'};

// ---- isEvaluation ----
check(isEvaluation(license({channel:'evaluation'}),server2025),true,'the evaluation channel');
check(isEvaluation(license({channel:'retail'}),evalEdition),true,'the edition ID ServerStandardEval');
check(isEvaluation(license({channel:'retail'}),{editionId:'serverdatacentereval'}),true,'the edition ID ignores case');
check(isEvaluation(license({channel:'volume-kms'}),server2025),false,'a KMS client is no evaluation');
check(isEvaluation(undefined,evalEdition),true,'the edition ID alone is an evaluation signal');
check(isEvaluation({available:false,reason:'error',collectedAt:iso(0)},{editionId:null}),false,'not available, no edition ID');

// ---- evaluationEnd ----
const evaluation=values=>license({channel:'evaluation',...values});
check(evaluationEnd(evaluation({expiresAt:iso(47*day)}),server2025,now),{state:'running',date:iso(47*day),daysLeft:47},'running: 47 days left');
check(evaluationEnd(evaluation({expiresAt:iso(46*day+60_000)}),server2025,now).daysLeft,47,'a part of a day rounds up');
check(evaluationEnd(evaluation({expiresAt:iso(47*day),evaluationEndsAt:iso(30*day)}),server2025,now),{state:'running',date:iso(30*day),daysLeft:30},'the earlier of expiresAt and evaluationEndsAt (evaluationEndsAt)');
check(evaluationEnd(evaluation({expiresAt:iso(20*day),evaluationEndsAt:iso(30*day)}),server2025,now),{state:'running',date:iso(20*day),daysLeft:20},'the earlier of expiresAt and evaluationEndsAt (expiresAt)');
check(evaluationEnd(evaluation({status:'initial-grace',expiresAt:iso(5*day),evaluationEndsAt:iso(90*day)}),server2025,now),{state:'running',date:iso(90*day),daysLeft:90},'expiresAt is the activation grace while not licensed: only evaluationEndsAt');
check(evaluationEnd(evaluation({expiresAt:iso(-3*day)}),server2025,now),{state:'ended',date:iso(-3*day),daysLeft:-3},'ended with a date: days left 0 or less');
check(evaluationEnd(evaluation({expiresAt:iso(0)}),server2025,now),{state:'ended',date:iso(0),daysLeft:0},'at the end it has ended');
check(evaluationEnd(evaluation({status:'notification'}),server2025,now),{state:'ended',date:null,daysLeft:0},'notification without a date has ended');
check(evaluationEnd(evaluation({status:'unlicensed'}),server2025,now),{state:'ended',date:null,daysLeft:0},'unlicensed without a date has ended');
check(evaluationEnd(evaluation({status:'initial-grace',expiresAt:iso(5*day)}),server2025,now),{state:'unknown'},'initial-grace without an evaluation date is unknown');
check(evaluationEnd(evaluation({status:'licensed'}),server2025,now),{state:'unknown'},'licensed without any date is unknown');
check(evaluationEnd(license({channel:'retail',expiresAt:iso(10*day)}),evalEdition,now),{state:'running',date:iso(10*day),daysLeft:10},'the edition ID makes a retail row an evaluation');
check(evaluationEnd(license({channel:'retail'}),server2025,now),null,'not an evaluation');
check(evaluationEnd({available:false,reason:'access-denied',collectedAt:iso(0)},evalEdition,now),null,'not available');
check(evaluationEnd(undefined,evalEdition,now),null,'not reported');
check(evaluationEnd(evaluation({expiresAt:'not a date',evaluationEndsAt:iso(9*day)}),server2025,now).daysLeft,9,'an invalid date is skipped');

// ---- notActivated and the grace end ----
const statuses={unlicensed:true,licensed:false,'initial-grace':true,'additional-grace':true,'non-genuine-grace':true,notification:true,'extended-grace':true,unknown:false};
for(const [status,expected] of Object.entries(statuses))check(notActivated(license({status})),expected,`notActivated: ${status}`);
check([notActivated(undefined),notActivated({available:false,reason:'not-found',collectedAt:iso(0)})],[false,false],'no license and not available are not "not activated"');
check(graceEnd(license({status:'initial-grace',expiresAt:iso(3*day)})),iso(3*day),'a grace state with expiresAt');
check(['extended-grace','additional-grace','non-genuine-grace'].map(status=>graceEnd(license({status,expiresAt:iso(day)}))),[iso(day),iso(day),iso(day)],'every grace state');
check([graceEnd(license({status:'licensed',expiresAt:iso(3*day)})),graceEnd(license({status:'notification',expiresAt:iso(3*day)})),graceEnd(license({status:'initial-grace'}))],[null,null,null],'licensed, notification and no date have no grace end');

// ---- The rounding is the certificate rounding ----
for(const offset of [-2.5*day,-1,0,1,day,1.2*day,47*day])check(daysLeftUntil(iso(offset),now),certificateDaysLeft(iso(offset),now),`daysLeftUntil = certificateDaysLeft at ${offset}`);

console.log(`PASS Windows license rules (${checks} checks): isEvaluation by channel and edition ID, evaluationEnd running, earlier date, grace minutes ignored before activation, ended with and without a date, unknown and not an evaluation, notActivated for every status, the grace end and the certificate rounding.`);
