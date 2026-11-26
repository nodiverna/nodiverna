// The job shown for a device (lib/job-display.ts): the running job, the device scope, schedules, recent results
// and the elapsed time.
import '../support/register.mjs';
import assert from 'node:assert/strict';
const {currentJob,jobElapsed}=await import('../../lib/job-display.ts');
const now=1800000000000;
const job=(id,state,extra={})=>({id,state,serverId:'a',action:'refresh',target:'',createdAt:now-10000,claimedAt:null,result:null,actor:'test',...extra});
const early=job('early','running',{claimedAt:now-9000}),later=job('later','running',{serverId:'b',claimedAt:now-4000});
assert.equal(currentJob([later,early],now)?.id,'early');
assert.equal(currentJob([early,later],now,'b')?.id,'later','current device wins among running jobs');
assert.equal(currentJob([job('pending','pending'),later],now,'a')?.id,'later','running takes priority over pending');
assert.equal(currentJob([job('future','pending',{notBefore:now+60000})],now),undefined);
assert.equal(currentJob([job('done','succeeded')],now),undefined,'old results are not presented as current');
assert.equal(currentJob([job('done','failed')],now,undefined,'done')?.state,'failed');
assert.equal(jobElapsed(early,now),'9 s');
assert.equal(jobElapsed({...early,claimedAt:now-65000},now),'1 min 5 s');
assert.equal(jobElapsed({...early,claimedAt:now+5000},now),'0 s');
assert.equal(jobElapsed(job('waiting','pending'),now),'');
assert.equal(jobElapsed({...early,claimedAt:null},now),'','unknown start never fabricates elapsed time');
console.log('PASS: running job selection, scoped device preference, future schedules, recent completion and truthful elapsed duration.');
