// The countdown to the automatic logout (ui/session/session-idle-state.ts): unknown data, activity, other tabs,
// the deadline, hard expiry and the logout text.
import assert from 'node:assert/strict';
import '../../support/register.mjs';
import '../../support/german-default.mjs';
import {readFile} from 'node:fs/promises';
const {idleCountdown,idleUrgent,idleLogoutText,countdownLabel,idlePillSeconds}=await import('../../../ui/session/session-idle-state.ts');
const session={authenticated:true,sessionId:'one',lastActivityAt:0,verifiedUntil:3600000,idleExpiresAt:3600000,sessionExpiresAt:86400000};
assert.equal(idleCountdown(null,60000,0),null,'unknown data must not show a countdown');
assert.equal(idleCountdown(session,59999,0),null,'active browsing keeps the corner clear');
assert.equal(idleCountdown(session,60000,0),3540,'inactivity shows the real server deadline');
assert.equal(countdownLabel(3540),'59:00');
assert.equal(countdownLabel(9),'0:09');
assert.equal(idleCountdown(session,90000,50000),null,'genuine local input hides the notice before renewal arrives');
assert.equal(idleCountdown({...session,lastActivityAt:50000},90000,0),null,'activity in another tab hides the notice');
assert.equal(idleCountdown({...session,sessionExpiresAt:120000},60000,0),60,'fixed session expiry wins over inactivity');
assert.equal(idleCountdown(session,3600000,0),null,'expired sessions cannot show time remaining');
assert.equal(idleCountdown({...session,authenticated:false},60000,0),null,'logout removes the timer');
// The login note names the configured timeout, and the countdown is
// urgent only for the last fifth of it (at most five minutes).
assert.equal(idleLogoutText(300000),'Du wirst nach 5 Minuten ohne Aktivität abgemeldet.');
assert.equal(idleLogoutText(900000),'Du wirst nach 15 Minuten ohne Aktivität abgemeldet.');
assert.equal(idleLogoutText(60000),'Du wirst nach 1 Minute ohne Aktivität abgemeldet.');
for(const value of [undefined,null,0,-1,59999,Number.NaN,'900000'])assert.equal(idleLogoutText(value),null,'no text for '+String(value));
assert.equal(idleUrgent(61,300000),false,'5 minutes: not urgent right after the notice appears');
assert.equal(idleUrgent(60,300000),true,'5 minutes: urgent for the last minute');
assert.equal(idleUrgent(181,900000),false);assert.equal(idleUrgent(180,900000),true,'15 minutes: the last three minutes');
for(const ms of [1800000,2700000,3600000]){assert.equal(idleUrgent(301,ms),false);assert.equal(idleUrgent(300,ms),true,'longer timeouts keep the five-minute threshold');}
const helper=await readFile(new URL('../../../ui/session/session-idle-state.ts',import.meta.url),'utf8');assert.ok(helper.includes('idleUrgent(seconds,status?.idleTimeoutMs)'),'the pill uses the relative threshold');assert.doesNotMatch(helper,/seconds<=300/);
// The top bar pill: seconds only inside the urgent window, else null.
for(const [minutes,threshold] of [[5,60],[15,180],[60,300]]){
 const timeout=minutes*60000,status={...session,idleExpiresAt:timeout,sessionExpiresAt:86400000,idleTimeoutMs:timeout};
 assert.equal(idlePillSeconds(status,timeout-(threshold+1)*1000,0),null,`${minutes} minutes: no pill before the urgent window`);
 assert.equal(idlePillSeconds(status,timeout-threshold*1000,0),threshold,`${minutes} minutes: the pill shows the remaining seconds at ${threshold}`);
 assert.equal(idlePillSeconds(status,timeout-125000,0),threshold>=125?125:null,`${minutes} minutes: follows idleUrgent at 2:05`);
}
const urgentStatus={...session,idleExpiresAt:300000,idleTimeoutMs:300000};
assert.equal(idlePillSeconds({...urgentStatus,authenticated:false},270000,0),null,'no pill without an authenticated session');
assert.equal(idlePillSeconds(null,270000,0),null,'no pill without a status');
assert.equal(idlePillSeconds(urgentStatus,270000,265000),null,'activity removes the pill');
assert.equal(idlePillSeconds(urgentStatus,300000,0),null,'no pill after the deadline');
assert.equal(idleUrgent(300,undefined),true,'without a value the old threshold applies');assert.equal(idleUrgent(301,undefined),false);
console.log('PASS session inactivity countdown and pill: unknown, activity, other tab, actual deadline, hard expiry and logout.');
