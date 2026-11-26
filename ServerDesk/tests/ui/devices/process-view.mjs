// Pure process inventory safety checks. No job is queued and no device is contacted.
import assert from 'node:assert/strict';
import {processView, processIdentity, currentKillCandidate} from '../../../ui/devices/diagnostics/process-view.ts';

const now = Date.parse('2026-10-08T08:00:00Z');
const at = offset => new Date(now + offset).toISOString();
const process = (changes = {}) => ({pid:1200, name:'worker.exe', startedAt:'2026-10-08T07:00:00.1234567Z', memoryMb:24, cpuSeconds:10, cpuPercent:2, protected:false, ...changes});
const server = (changes = {}, inventory = {}) => ({
  id:'process-test', name:'Process Test', lastSeen:now - 1000, revoked:0, management:1,
  snapshot:{processes:[process()], processInventory:{collectedAt:at(-30000), count:1, complete:true, truncated:false, intervalSeconds:30, ...inventory}},
  ...changes,
});
const diagnosis = (offset, processes, changes = {}) => ({id:'diagnostic-result', data:{at:at(offset), data:{processes, count:processes.length, ...changes}}});

const automatic = processView(server(), undefined, now);
assert.equal(automatic.source, 'automatic');
assert.equal(automatic.fresh, true);
assert.equal(automatic.intervalSeconds, 30);
assert.equal(currentKillCandidate(automatic, process())?.pid, 1200);

const old = diagnosis(-60000, [process({memoryMb:200, cpuPercent:70, user:'TEST\\user', sid:'S-1-5-21', path:'C:\\worker.exe'}), process({pid:800})]);
const enriched = processView(server(), old, now);
assert.equal(enriched.rows.length, 1, 'a stopped process is not resurrected by an old diagnostic result');
assert.equal(enriched.rows[0].user, 'TEST\\user', 'immutable metadata enriches only the matching process identity');
assert.equal(enriched.rows[0].cpuPercent, 2, 'fresh CPU usage is never overwritten by an old diagnostic sample');
assert.equal(enriched.rows[0].memoryMb, 24, 'fresh working set is never overwritten by an old diagnostic sample');

const reused = process({startedAt:'2026-10-08T07:30:00.1234567Z'});
const recycledServer = server({snapshot:{...server().snapshot, processes:[reused]}});
const recycled = processView(recycledServer, old, now);
assert.equal(recycled.rows[0].user, undefined, 'a recycled PID does not inherit the previous process owner');
assert.equal(currentKillCandidate(recycled, process()), null, 'an open confirmation cannot terminate a replacement process');

assert.notEqual(processIdentity(process()), processIdentity(process({startedAt:'2026-10-08T07:00:00.1234568Z'})),
  'sub-millisecond start-time precision is retained');
assert.equal(processIdentity(process()), processIdentity(process({startedAt:'2026-10-08T09:00:00.123456700+02:00'})),
  'equivalent timezone forms retain the same exact process identity');
for (const row of [process({startedAt:''}), process({startedAt:'not a timestamp'}), process({pid:'1200'}), process({pid:0})]) {
  assert.equal(processIdentity(row), null);
  assert.equal(currentKillCandidate(automatic, row), null, 'termination requires a valid numeric PID and exact start time');
}
for (const protectedState of [true, undefined, null]) {
  const candidate = process({protected:protectedState});
  const view = processView(server({snapshot:{...server().snapshot, processes:[candidate]}}), undefined, now);
  assert.equal(currentKillCandidate(view, candidate), null, 'unknown and protected process states cannot be terminated');
}

const newer = diagnosis(-5000, [process({memoryMb:36, cpuPercent:4})]);
assert.equal(processView(server(), newer, now).source, 'diagnostic', 'a requested newer detail measurement remains available until the next telemetry sample');
assert.equal(processView(server({}, {collectedAt:at(-1000)}), newer, now).source, 'automatic', 'the next telemetry sample automatically replaces the manual list');
const legacy = server({snapshot:{processes:[process()]}});
assert.equal(processView(legacy, newer, now).source, 'diagnostic', 'older agents retain explicit diagnostic queries');
assert.equal(processView(legacy, undefined, now).source, 'none', 'legacy top-process snapshots are not mistaken for a complete current list');

for (const device of [server({lastSeen:now - 120000}), server({}, {collectedAt:at(-120000)}), server({maintenance:{state:'updating'}})]) {
  const view = processView(device, undefined, now);
  assert.equal(view.fresh, false, 'disconnected, old and updating devices do not present current process data');
  assert.equal(currentKillCandidate(view, process()), null);
}
const failed = processView(server({}, {complete:false, error:'Process collection failed'}), old, now);
assert.equal(failed.source, 'diagnostic');
assert.equal(failed.collectionError, 'Process collection failed', 'collection failure remains visible alongside saved fallback data');
const future = processView(server({}, {collectedAt:at(60000)}), undefined, now);
assert.equal(future.source, 'none', 'a future clock cannot make an inventory indefinitely fresh');
assert.equal(future.fresh, false);
const truncated = processView(server({}, {count:8000, truncated:true}), undefined, now);
assert.equal(truncated.count, 8000);
assert.equal(truncated.truncated, true, 'safety limits are surfaced rather than presented as all processes');

console.log('PASS: automatic process inventory, safe source selection, exact process identity, recycled-PID protection, stale data and explicit limits.');
