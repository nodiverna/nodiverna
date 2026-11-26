// The maintenance scheduler of the portal process (runtime/maintenance-scheduler.mjs)
// and the lock, slot and continuation rules of runtime/maintenance.mjs, on
// PostgreSQL test databases with a fake clock and fake timers. Each case gets
// its own migrated database and object folder.
// No test reaches GitHub: the release check of a maintenance run fails as unreachable.
import '../support/offline-fetch.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDatabase, sql } from '../../runtime/database.mjs';
import { createStorage } from '../../runtime/storage.mjs';
import {
  maintenanceChainLimit, maintenanceContinuationGapMs, maintenanceFailures, maintenanceLeaseMs, maintenanceRunAuditAction, maintenanceSlot, nextMaintenanceSlot, pendingContinuation, startMaintenance,
} from '../../runtime/maintenance.mjs';
import { createMaintenanceScheduler, ensureMaintenanceScheduler, firstTickMs, nextMaintenanceRun, tickMs } from '../../runtime/maintenance-scheduler.mjs';
import { runReleaseCheck } from '../../runtime/release-import.mjs';
import { testDatabase } from '../support/postgres.mjs';

const minute = 60_000, hour = 60 * minute, day = 24 * hour;
const start = Date.UTC(2026, 9, 16, 12);
// A failed run stores the key of its reason, never the raw message.
const takeoverError = 'serverMessage.maintenance.lockExpired';
const lostError = 'serverMessage.maintenance.lockLost';

// Timers that only record; a test fires them by hand.
function fakeTimers() {
  const entries = [];
  const handle = entry => ({ unref() { entry.unref = true; return this; } });
  return {
    entries,
    setTimeout(fn, ms) { const entry = { kind: 'timeout', fn, ms, unref: false, cleared: false }; entries.push(entry); entry.handle = handle(entry); return entry.handle; },
    setInterval(fn, ms) { const entry = { kind: 'interval', fn, ms, unref: false, cleared: false }; entries.push(entry); entry.handle = handle(entry); return entry.handle; },
    clearTimeout(value) { const entry = entries.find(item => item.handle === value); if (entry) entry.cleared = true; },
    clearInterval(value) { const entry = entries.find(item => item.handle === value); if (entry) entry.cleared = true; },
    live: kind => entries.filter(entry => entry.kind === kind && !entry.cleared),
  };
}

async function fixture(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'serverdesk-scheduler-'));
  const database = await testDatabase();
  const others = [];
  try {
    const storage = createStorage({ OBJECT_STORAGE_DRIVER: 'filesystem', OBJECT_STORAGE_PATH: path.join(directory, 'objects') });
    const clock = { now: start, read: () => clock.now };
    const logs = [];
    const scheduler = (options = {}) => createMaintenanceScheduler({ database, storage, env: {}, clock: clock.read, timers: fakeTimers(), log: message => logs.push(message), ...options });
    const second = () => { const other = createDatabase({ url: database.url, password: database.password, max: 4 }); others.push(other); return other; };
    return await run({ database, storage, clock, logs, scheduler, second });
  } finally {
    for (const other of others) await other.close().catch(() => {});
    await database.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

const runs = database => database.query(sql`SELECT id,started_at,finished_at,status,trigger,requested_by,result,error FROM maintenance_runs ORDER BY id`);
const lock = database => database.one(sql`SELECT holder,run_id,acquired_at,expires_at FROM maintenance_lock WHERE id=1`);
const setSchedule = (database, runAt, timeZone) => database.exec(sql`UPDATE maintenance_settings SET run_at=${runAt},time_zone=${timeZone} WHERE id=1`);
const insertAudit = (database, at) => database.exec(sql`INSERT INTO audit(at,actor,action,target,server_id,scope) VALUES(${at},'tester','test.action','target',NULL,'portal')`);
const plainAudit = async database => (await database.query(sql`SELECT at FROM audit WHERE action <> 'Audit retention applied' ORDER BY at`)).map(row => row.at);
const runAudits = async database => (await database.query(sql`SELECT target FROM audit WHERE action=${maintenanceRunAuditAction} ORDER BY id`)).map(row => row.target);
// The gap of each continuation: its start minus the end of the run before it.
const continuationGaps = rows => rows.slice(1).flatMap((row, index) => (row.trigger === 'continuation' ? [row.started_at - rows[index].finished_at] : []));

test('the slot follows the wall-clock time of the zone, with DST from Intl', () => {
  // 03:00 UTC by default.
  assert.equal(maintenanceSlot(start, 180, 'UTC'), Date.UTC(2026, 9, 16, 3));
  assert.equal(maintenanceSlot(Date.UTC(2026, 9, 16, 2, 59), 180, 'UTC'), Date.UTC(2026, 9, 15, 3), 'before 03:00 the slot is the day before');
  assert.equal(maintenanceSlot(Date.UTC(2026, 9, 16, 3), 180, 'UTC'), Date.UTC(2026, 9, 16, 3), 'the slot itself counts');
  assert.equal(nextMaintenanceSlot(Date.UTC(2026, 9, 16, 3), 180, 'UTC'), Date.UTC(2026, 9, 17, 3), 'the next slot is strictly later');
  // 04:30 in Berlin is 02:30 UTC in summer time.
  assert.equal(maintenanceSlot(Date.UTC(2026, 6, 1, 12), 270, 'Europe/Berlin'), Date.UTC(2026, 6, 1, 2, 30));
  // Spring forward on 2027-03-28: 02:30 does not exist and falls to 03:00 CEST (01:00 UTC).
  assert.equal(maintenanceSlot(Date.UTC(2027, 2, 28, 12), 150, 'Europe/Berlin'), Date.UTC(2027, 2, 28, 1));
  assert.equal(nextMaintenanceSlot(Date.UTC(2027, 2, 27, 12), 150, 'Europe/Berlin'), Date.UTC(2027, 2, 28, 1));
  // Fall back on 2026-10-25: 02:30 exists twice; the latest one at or before now.
  assert.equal(maintenanceSlot(Date.UTC(2026, 9, 25, 0, 45), 150, 'Europe/Berlin'), Date.UTC(2026, 9, 25, 0, 30), 'between both: the first one');
  assert.equal(maintenanceSlot(Date.UTC(2026, 9, 25, 12), 150, 'Europe/Berlin'), Date.UTC(2026, 9, 25, 1, 30), 'after both: the second one');
  // An unknown zone counts as UTC; midnight and 23:59 work.
  assert.equal(maintenanceSlot(start, 0, 'Mars/Base'), Date.UTC(2026, 9, 16));
  assert.equal(maintenanceSlot(start, 1439, 'UTC'), Date.UTC(2026, 9, 15, 23, 59));
  assert.equal(maintenanceSlot(Date.UTC(2026, 9, 16, 12), 60, 'Asia/Kolkata'), Date.UTC(2026, 9, 15, 19, 30), 'a zone with a half-hour offset');
});

test('the schedule fires a run at the first tick, then once per slot, also in Europe/Berlin and on a DST day', async () => {
  await fixture(async ({ database, clock, scheduler }) => {
    const instance = scheduler();
    const outcome = await instance.tick();
    assert.equal(outcome.status, 'succeeded');
    let rows = await runs(database);
    assert.equal(rows.length, 1, 'a fresh installation runs at its first tick');
    assert.deepEqual([rows[0].status, rows[0].trigger, rows[0].requested_by, rows[0].started_at], ['succeeded', 'schedule', null, start]);
    assert.deepEqual(Object.keys(JSON.parse(rows[0].result)), ['retention', 'audit', 'customerAudit', 'jobs', 'jobOutputs', 'assistantScripts', 'softwareChanges', 'alerts', 'notifications', 'integrityEvents', 'transfers', 'usageReport', 'releaseImport']);
    assert.deepEqual(JSON.parse(rows[0].result).releaseImport, { status: 'failed', imported: 0, present: 0, failed: 0, removedChunks: 0 }, 'the release check fails offline; the run still succeeds');
    assert.deepEqual(JSON.parse(rows[0].result).usageReport, { status: 'disabled' });
    assert.deepEqual(await lock(database), { holder: null, run_id: null, acquired_at: null, expires_at: null }, 'the lock is cleared after the run');

    clock.now = start + minute;
    assert.equal(await instance.tick(), null);
    clock.now = Date.UTC(2026, 9, 17, 2, 59);
    assert.equal(await instance.tick(), null, 'a tick before the next slot does nothing');
    assert.equal((await runs(database)).length, 1);
    clock.now = Date.UTC(2026, 9, 17, 3);
    assert.equal((await instance.tick()).status, 'succeeded', 'the next slot runs');
    assert.equal((await runs(database)).length, 2);

    // A changed time and zone apply from the next tick, without a restart.
    await setSchedule(database, 270, 'Europe/Berlin');
    clock.now = Date.UTC(2026, 9, 18, 2, 29); // 04:29 CEST
    assert.equal(await instance.tick(), null);
    clock.now = Date.UTC(2026, 9, 18, 2, 30); // 04:30 CEST
    assert.equal((await instance.tick()).status, 'succeeded');
    clock.now = Date.UTC(2026, 9, 18, 2, 31);
    assert.equal(await instance.tick(), null);
    rows = await runs(database);
    assert.equal(rows.length, 3, 'the Berlin slot runs once');
    assert.equal(rows[2].started_at, Date.UTC(2026, 9, 18, 2, 30));

    // DST spring forward: 02:30 falls to 03:00 CEST once.
    await setSchedule(database, 150, 'Europe/Berlin');
    clock.now = Date.UTC(2027, 2, 27, 2);
    assert.equal((await instance.tick()).status, 'succeeded', 'the slot of the day before the change');
    clock.now = Date.UTC(2027, 2, 28, 0, 59);
    assert.equal(await instance.tick(), null, '01:59 CET: the slot of the day before already ran');
    clock.now = Date.UTC(2027, 2, 28, 1);
    assert.equal((await instance.tick()).status, 'succeeded', '03:00 CEST: the spring-forward slot');
    clock.now = Date.UTC(2027, 2, 28, 1, 1);
    assert.equal(await instance.tick(), null);
    clock.now = Date.UTC(2027, 2, 28, 12);
    assert.equal(await instance.tick(), null);
    assert.deepEqual((await runs(database)).slice(3).map(row => [row.trigger, row.started_at]), [['schedule', Date.UTC(2027, 2, 27, 2)], ['schedule', Date.UTC(2027, 2, 28, 1)]]);
  });
});

test('two instances that tick at the same moment write exactly one run', async () => {
  await fixture(async ({ database, storage, clock, second }) => {
    const make = pool => createMaintenanceScheduler({ database: pool, storage, env: {}, clock: clock.read, timers: fakeTimers(), log: () => {} });
    const [a, b] = [make(database), make(second())];
    for (const moment of [start, Date.UTC(2026, 9, 17, 3, 0, 5)]) {
      clock.now = moment;
      const outcomes = await Promise.all([a.tick(), b.tick()]);
      assert.equal(outcomes.filter(Boolean).length, 1, 'one instance runs, the other skips');
    }
    const rows = await runs(database);
    assert.deepEqual(rows.map(row => [row.trigger, row.status]), [['schedule', 'succeeded'], ['schedule', 'succeeded']], 'one row per slot');
  });
});

test('an expired lock is taken over and its running row fails; a live lock blocks the tick', async () => {
  await fixture(async ({ database, clock, scheduler, logs }) => {
    const { id: orphan } = await database.one(sql`INSERT INTO maintenance_runs(started_at,status,trigger) VALUES(${start - day},'running','schedule') RETURNING id`);
    await database.exec(sql`UPDATE maintenance_lock SET holder='other-host:1:dead',run_id=${orphan},acquired_at=${start - day},expires_at=${start - day + maintenanceLeaseMs} WHERE id=1`);
    const outcome = await scheduler().tick();
    assert.equal(outcome.status, 'succeeded');
    const [old, fresh] = await runs(database);
    assert.deepEqual([old.id, old.status, old.error, old.finished_at, old.result], [orphan, 'failed', takeoverError, start, null], 'the orphaned run is recorded as failed');
    assert.deepEqual([fresh.status, fresh.trigger], ['succeeded', 'schedule'], 'the new run proceeds normally');
    assert.equal((await lock(database)).holder, null);

    // A lock that has not expired: no row and no log line.
    await database.exec(sql`UPDATE maintenance_lock SET holder='other-host:2:live',run_id=NULL,acquired_at=${start},expires_at=${Date.UTC(2026, 9, 17, 3) + maintenanceLeaseMs} WHERE id=1`);
    clock.now = Date.UTC(2026, 9, 17, 3);
    const instance = scheduler();
    assert.equal(await instance.tick(), null);
    clock.now += minute;
    assert.equal(await instance.tick(), null);
    assert.equal((await runs(database)).length, 2, 'the held lock writes no row');
    assert.deepEqual(logs, []);
    assert.equal((await lock(database)).holder, 'other-host:2:live', 'the foreign lock stays');
  });
});

// A transfer to clear whose storage listing waits for a gate, so a run stays
// inside its last area while the test moves the clock and fires the renewal.
async function slowRun({ database, storage, scheduler }) {
  const id = '00000000-0000-4000-8000-000000000001';
  await database.exec(sql`INSERT INTO transfers(id,server_id,principal,direction,path,size,sha256,state,overwrite,created_at,updated_at,expires_at) VALUES(${id},'device-a','private:tester','upload','C:\\Temp\\a.bin',10,${'a'.repeat(64)},'cancelled',0,${start - day},${start - day},${start + day})`);
  let entered, release;
  const inside = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const slow = { ...storage, async list(options) { entered(); await gate; return storage.list(options); } };
  const timers = fakeTimers();
  const instance = scheduler({ storage: slow, timers });
  const running = instance.tick();
  await inside;
  const [renewal] = timers.live('interval');
  assert.equal(renewal.ms, 60_000, 'the lease is renewed every 60 seconds');
  assert.equal(renewal.unref, true);
  return { running, renewal, release, timers, holder: (await lock(database)).holder };
}

test('a run longer than the lease renews it and keeps its lock', async () => {
  await fixture(async context => {
    const { database, clock } = context;
    const { running, renewal, release, timers, holder } = await slowRun(context);
    const held = await lock(database);
    assert.equal(held.expires_at, start + maintenanceLeaseMs);
    assert.match(holder, /^.+:\d+:[0-9a-f]{12}$/, 'holder is <hostname>:<pid>:<random>');
    assert.equal(held.run_id, (await runs(database))[0].id, 'the lock names the run');
    for (const step of [9, 18, 27]) {
      clock.now = start + step * minute;
      renewal.fn();
      await new Promise(resolve => setTimeout(resolve, 50));
      const renewed = await lock(database);
      assert.deepEqual([renewed.holder, renewed.expires_at], [holder, clock.now + maintenanceLeaseMs], `renewed after ${step} minutes`);
    }
    release();
    assert.equal((await running).status, 'succeeded', 'the run outlived its first lease and succeeded');
    assert.equal(timers.live('interval').length, 0, 'the renewal stops with the run');
    assert.equal((await lock(database)).holder, null);
  });
});

test('a foreign takeover during the run makes it fail before its next area', async () => {
  await fixture(async context => {
    const { database, clock } = context;
    const { running, renewal, release } = await slowRun(context);
    await database.exec(sql`UPDATE maintenance_lock SET holder='other-host:3:thief',expires_at=${clock.now + maintenanceLeaseMs} WHERE id=1`);
    renewal.fn();
    await new Promise(resolve => setTimeout(resolve, 50));
    release();
    assert.equal((await running).status, 'failed');
    const [row] = await runs(database);
    assert.deepEqual([row.status, row.error, row.result], ['failed', lostError, null], 'recorded as failed with the lock message');
    assert.equal((await lock(database)).holder, 'other-host:3:thief', 'the run does not clear a lock it lost');
  });
});

test('a run with more to delete continues at the next ticks, at most 24 runs per slot; a failed run stops the chain', async () => {
  await fixture(async ({ database, clock, scheduler }) => {
    for (let index = 0; index < 5; index++) await insertAudit(database, start - (40 + index) * day);
    const instance = scheduler({ runOptions: { batchSize: 1, maxBatches: 1 } });
    for (let tick = 0; tick < 7; tick++) {
      await instance.tick();
      clock.now += tickMs;
    }
    const rows = await runs(database);
    assert.deepEqual(rows.map(row => row.trigger), ['schedule', 'continuation', 'continuation', 'continuation', 'continuation'], 'continuations until more is false');
    assert.deepEqual(rows.map(row => JSON.parse(row.result).audit), [...Array(4).fill({ deleted: 1, more: true }), { deleted: 1, more: false }]);
    assert.deepEqual(await plainAudit(database), []);
  });
  await fixture(async ({ database, clock, scheduler }) => {
    for (let index = 0; index < 30; index++) await insertAudit(database, start - (40 + index) * day);
    const instance = scheduler({ runOptions: { batchSize: 1, maxBatches: 1 } });
    for (let tick = 0; tick < 27; tick++) {
      await instance.tick();
      clock.now += tickMs;
    }
    const rows = await runs(database);
    assert.equal(rows.length, maintenanceChainLimit, '24 runs in total for the slot');
    assert.deepEqual([rows[0].trigger, new Set(rows.slice(1).map(row => row.trigger))], ['schedule', new Set(['continuation'])]);
    assert.equal(JSON.parse(rows.at(-1).result).audit.more, true, 'the last run still had more; the limit stopped the chain');
    assert.equal((await plainAudit(database)).length, 6);
    // The next slot starts a new chain.
    clock.now = Date.UTC(2026, 9, 17, 3);
    await instance.tick();
    assert.equal((await runs(database)).at(-1).trigger, 'schedule');
  });
  await fixture(async ({ database, storage, clock, scheduler }) => {
    for (let index = 0; index < 3; index++) await insertAudit(database, start - (40 + index) * day);
    await database.exec(sql`INSERT INTO transfers(id,server_id,principal,direction,path,size,sha256,state,overwrite,created_at,updated_at,expires_at) VALUES('00000000-0000-4000-8000-000000000002','device-a','private:tester','upload','C:\\Temp\\b.bin',10,${'b'.repeat(64)},'cancelled',0,${start - day},${start - day},${start + day})`);
    await storage.put('transfers/00000000-0000-4000-8000-000000000002/0/x', 'chunk');
    const failing = { ...storage, async delete() { throw new Error('storage offline'); } };
    const instance = scheduler({ storage: failing, runOptions: { batchSize: 1, maxBatches: 1 } });
    for (let tick = 0; tick < 3; tick++) {
      await instance.tick();
      clock.now += tickMs;
    }
    const rows = await runs(database);
    assert.deepEqual(rows.map(row => [row.trigger, row.status]), [['schedule', 'failed']], 'a failed run does not continue');
    assert.equal(JSON.parse(rows[0].result).audit.more, true);
  });
  await fixture(async ({ database }) => {
    // The chain after a manual run has the same limit; a CLI run never continues.
    const more = JSON.stringify({ audit: { deleted: 1, more: true }, customerAudit: [], jobs: { deleted: 0, more: false }, jobOutputs: { deleted: 0, more: false }, transfers: { cleared: 0, failed: 0, more: false } });
    const insert = (trigger, at, status = 'succeeded', result = more) => database.exec(sql`INSERT INTO maintenance_runs(started_at,finished_at,status,trigger,result) VALUES(${at},${at},${status},${trigger},${result})`);
    await insert('cli', start);
    assert.equal(await pendingContinuation(database), null, 'a CLI run does not continue');
    await insert('manual', start + 1);
    assert.deepEqual(await pendingContinuation(database), { after: (await runs(database)).at(-1).id, length: 1, dueAt: start + 1 + 60_000 }, 'due one minute after the manual run ended');
    for (let index = 0; index < 22; index++) await insert('continuation', start + 2 + index);
    assert.equal((await pendingContinuation(database)).length, 23);
    await insert('continuation', start + 100);
    assert.equal(await pendingContinuation(database), null, 'manual run and 23 continuations: the limit');
    await insert('schedule', start + 200, 'succeeded', JSON.stringify({ audit: { deleted: 0, more: false }, customerAudit: [{ customerId: 'c', auditDays: 7, deleted: 3, more: true }], jobs: { deleted: 0, more: false }, jobOutputs: { deleted: 0, more: false }, transfers: { cleared: 0, failed: 0, more: false } }));
    assert.equal((await pendingContinuation(database)).length, 1, 'a customer pass with more continues');
  });
});

test('a pending migration skips the run with one log line', async () => {
  await fixture(async ({ database, clock, scheduler, logs }) => {
    const last = await database.one(sql`SELECT name,checksum,applied_at FROM _serverdesk_migrations ORDER BY name DESC LIMIT 1`);
    await database.exec(sql`DELETE FROM _serverdesk_migrations WHERE name=${last.name}`);
    const instance = scheduler();
    for (let tick = 0; tick < 3; tick++) {
      assert.equal(await instance.tick(), null);
      clock.now += tickMs;
    }
    assert.deepEqual(await runs(database), [], 'no row');
    assert.deepEqual(logs, ['ServerDesk: Maintenance waits until all migrations are applied.'], 'one log line');
    await database.exec(sql`INSERT INTO _serverdesk_migrations(name,checksum,applied_at) VALUES(${last.name},${last.checksum},${last.applied_at})`);
    assert.equal((await instance.tick()).status, 'succeeded', 'the run starts once the migrations are applied');
  });
});

test('the retention: stored value, else environment start value, else 30; an invalid start value fails the run', async () => {
  await fixture(async ({ database, clock, scheduler }) => {
    const nextDay = () => { clock.now += day; };
    for (const age of [9, 11, 14, 16, 39, 41]) await insertAudit(database, start + 5 * day - age * day);
    const retention = async () => JSON.parse((await runs(database)).at(-1).result).retention;

    await scheduler().tick();
    assert.deepEqual(await retention(), { auditDays: 30, jobDays: 30, softwareDays: 365, alertDays: 90 }, 'no stored and no environment value: 30 (software changes: 365)');
    nextDay();
    await scheduler({ env: { AUDIT_RETENTION_DAYS: '15', JOB_RETENTION_DAYS: '', SOFTWARE_CHANGE_RETENTION_DAYS: '90' } }).tick();
    assert.deepEqual(await retention(), { auditDays: 15, jobDays: 30, softwareDays: 90, alertDays: 90 }, 'environment 15 with a NULL column; an empty variable counts as unset; the scheduled run takes SOFTWARE_CHANGE_RETENTION_DAYS');
    nextDay();
    await database.exec(sql`UPDATE maintenance_settings SET audit_days=40 WHERE id=1`);
    await scheduler({ env: { AUDIT_RETENTION_DAYS: '15' } }).tick();
    assert.deepEqual(await retention(), { auditDays: 40, jobDays: 30, softwareDays: 365, alertDays: 90 }, 'stored 40 beats environment 15');
    nextDay();
    await database.exec(sql`UPDATE maintenance_settings SET audit_days=10 WHERE id=1`);
    await scheduler({ env: { AUDIT_RETENTION_DAYS: 'abc' } }).tick();
    assert.deepEqual(await retention(), { auditDays: 10, jobDays: 30, softwareDays: 365, alertDays: 90 }, 'a changed stored value applies to the next run without a restart; the invalid variable has no effect');
    assert.deepEqual((await plainAudit(database)).map(at => Math.round((clock.now - at) / day)), [9, 7], 'the run deleted the rows older than 10 days and kept the row of 9 days');
    nextDay();
    await database.exec(sql`UPDATE maintenance_settings SET audit_days=NULL WHERE id=1`);
    const outcome = await scheduler({ env: { JOB_RETENTION_DAYS: 'abc' } }).tick();
    assert.equal(outcome.status, 'failed');
    const failed = (await runs(database)).at(-1);
    assert.deepEqual([failed.status, failed.error, failed.result, failed.trigger], ['failed', 'serverMessage.maintenance.retentionInvalid', null, 'schedule'], 'the row stores the reason key, not the variable text');
  });
});

test('a failed run stores a reason key and logs the raw message once; an unclassified error is internal', async () => {
  assert.deepEqual(maintenanceFailures, ['retentionInvalid', 'lockLost', 'lockExpired', 'transfersFailed', 'internal'], 'the fixed list of reasons');
  await fixture(async ({ database, logs, scheduler }) => {
    // A database that fails one statement of the run with a message that names internals.
    const failing = new Proxy(database, { get(target, key) {
      if (key === 'query') return async statement => { if (statement.parts.join('?').includes('FROM customers ORDER BY id')) throw new Error('bucket secret-name unreachable'); return target.query(statement); };
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const outcome = await scheduler({ database: failing }).tick();
    assert.equal(outcome.status, 'failed');
    const [row] = await runs(database);
    assert.deepEqual([row.status, row.error, row.result], ['failed', 'serverMessage.maintenance.internal', null], 'an unclassified error stores internal');
    assert.deepEqual(logs, [`ServerDesk: Maintenance run ${row.id} failed: bucket secret-name unreachable`], 'the raw message goes to the log, once');
    assert.deepEqual(await runAudits(database), [], 'a scheduled run writes no Run now audit row');
  });
});

test('the Run now audit row commits with the manual run row: a lock lost before the insert writes neither', async () => {
  await fixture(async ({ database, storage, clock }) => {
    const manual = verify => startMaintenance(database, { trigger: 'manual', requestedBy: 'owner@example.test', storage, env: {}, clock: clock.read, timers: fakeTimers(), verify });
    // Another instance takes the lock between the take and the insert.
    const stolen = await manual(async () => { await database.exec(sql`UPDATE maintenance_lock SET holder='other-host:4:thief',expires_at=${start + maintenanceLeaseMs} WHERE id=1`); return true; });
    assert.equal(stolen.status, 'locked');
    assert.deepEqual([await runs(database), await runAudits(database)], [[], []], 'no run row and no audit row');
    await database.exec(sql`UPDATE maintenance_lock SET holder=NULL,run_id=NULL,acquired_at=NULL,expires_at=NULL WHERE id=1`);
    const started = await manual();
    assert.equal((await started.finished).status, 'succeeded');
    assert.deepEqual(await runAudits(database), [`Run now, trigger manual, run ${started.runId}`], 'one audit row for the manual run');
    const audit = await database.one(sql`SELECT at,actor,scope,server_id,customer_id FROM audit WHERE action=${maintenanceRunAuditAction}`);
    assert.deepEqual(audit, { at: (await runs(database))[0].started_at, actor: 'owner@example.test', scope: 'portal', server_id: null, customer_id: null });
  });
});

test('a continuation starts at least 60 seconds after the run before it ended, also over a whole chain', async () => {
  assert.equal(maintenanceContinuationGapMs, 60_000);
  const settings = { runAt: 180, timeZone: 'UTC' };
  // The first run ends 5 s after its tick: the next tick (55 s after the end) waits, the tick after it starts the continuation.
  await fixture(async ({ database, storage, clock, scheduler }) => {
    for (let index = 0; index < 3; index++) await insertAudit(database, start - (40 + index) * day);
    // Listing the one transfer takes 5 s on the scheduler clock; later runs have no transfer to list.
    await database.exec(sql`INSERT INTO transfers(id,server_id,principal,direction,path,size,sha256,state,overwrite,created_at,updated_at,expires_at) VALUES('00000000-0000-4000-8000-000000000003','device-a','private:tester','upload','C:\\Temp\\d.bin',10,${'d'.repeat(64)},'cancelled',0,${start - day},${start - day},${start + day})`);
    // Only the transfer listing is slow; the chunk cleanup of the release check lists agent-releases/ without delay.
    const slow = { ...storage, async list(options) { if (!String(options?.prefix ?? '').startsWith('agent-releases/')) clock.now += 5000; return storage.list(options); } };
    const instance = scheduler({ storage: slow, runOptions: { batchSize: 1, maxBatches: 1 } });
    assert.equal((await instance.tick()).status, 'succeeded');
    let rows = await runs(database);
    assert.equal(rows[0].finished_at, start + 5000, 'the first run ended 5 s after its tick');
    assert.equal((await pendingContinuation(database)).dueAt, start + 65_000, 'due one minute after the end');
    clock.now = start + tickMs;
    assert.equal(await instance.tick(), null, '55 s after the end: no run');
    assert.equal((await runs(database)).length, 1);
    assert.equal(await nextMaintenanceRun(database, clock.now, settings, start + 2 * tickMs), start + 2 * tickMs, 'nextRunAt: the next tick when it is at or after the due time');
    assert.equal(await nextMaintenanceRun(database, clock.now, settings, start + tickMs + 1000), start + 2 * tickMs + 1000, 'nextRunAt: nextTickAt plus whole ticks');
    assert.equal(await nextMaintenanceRun(database, start + 10_000, settings, null), start + 10_000 + tickMs, 'without a scheduler: now + 60 s when it is later than the due time');
    assert.equal(await nextMaintenanceRun(database, start + 1000, settings, null), start + 65_000, 'without a scheduler: the due time when it is later');
    clock.now = start + 2 * tickMs;
    assert.equal((await instance.tick()).status, 'succeeded', 'the tick after it starts the continuation');
    rows = await runs(database);
    assert.deepEqual(rows.map(row => row.trigger), ['schedule', 'continuation']);
    assert.ok(rows[1].started_at - rows[0].finished_at >= 60_000);
  });
  // A whole chain on a clock that moves 700 ms on every read: every gap is at least 60 s, and the limit holds.
  await fixture(async ({ database, clock, scheduler }) => {
    for (let index = 0; index < 30; index++) await insertAudit(database, start - (40 + index) * day);
    const read = () => { clock.now += 700; return clock.now; };
    const instance = scheduler({ clock: read, runOptions: { batchSize: 1, maxBatches: 1 } });
    let idle = 0;
    for (let tick = 0; tick < 60; tick++) {
      if (await instance.tick() === null) idle++;
      clock.now = start + (tick + 1) * tickMs;
    }
    const rows = await runs(database);
    assert.equal(rows.length, maintenanceChainLimit, 'the 24-run limit still holds');
    assert.ok(continuationGaps(rows).every(gap => gap >= 60_000), `every continuation starts at least 60 s after the end before it: ${continuationGaps(rows)}`);
    assert.ok(idle > 0, 'some ticks wait');
    assert.deepEqual(await runAudits(database), [], 'continuations write no Run now audit row');
  });
  // After a manual run the same gap applies.
  await fixture(async ({ database, clock, scheduler }) => {
    const more = JSON.stringify({ audit: { deleted: 1, more: true }, customerAudit: [], jobs: { deleted: 0, more: false }, jobOutputs: { deleted: 0, more: false }, transfers: { cleared: 0, failed: 0, more: false } });
    await database.exec(sql`INSERT INTO maintenance_runs(started_at,finished_at,status,trigger,requested_by,result) VALUES(${start - 1000},${start + 30_000},'succeeded','manual','owner',${more})`);
    const instance = scheduler();
    // The manual run started after today's slot, so only the continuation counts.
    clock.now = start + 30_000 + 59_999;
    assert.equal(await instance.tick(), null, 'one millisecond too early');
    clock.now = start + 30_000 + 60_000;
    assert.equal((await instance.tick()).status, 'succeeded', 'exactly one minute after the end');
    const rows = await runs(database);
    assert.deepEqual(rows.map(row => row.trigger), ['manual', 'continuation']);
    assert.deepEqual(continuationGaps(rows), [60_000]);
  });
});

test('one scheduler per process: off, no DATABASE_URL, timers with unref and a tick that never throws', async () => {
  const key = Symbol.for('serverdesk.runtime.maintenance-scheduler');
  assert.equal(await ensureMaintenanceScheduler({ DATABASE_URL: 'postgres://serverdesk@localhost:5432/x', MAINTENANCE_SCHEDULER: 'off' }), null, 'MAINTENANCE_SCHEDULER=off');
  assert.equal(await ensureMaintenanceScheduler({ DATABASE_URL: 'postgres://serverdesk@localhost:5432/x', MAINTENANCE_SCHEDULER: ' OFF ' }), null);
  assert.equal(await ensureMaintenanceScheduler({}), null, 'no DATABASE_URL');
  assert.equal(globalThis[key], undefined, 'nothing is started');

  const timers = fakeTimers(), logs = [];
  let calls = 0;
  const broken = { one: async () => { calls++; throw new Error('database offline'); }, query: async () => { throw new Error('database offline'); }, exec: async () => { throw new Error('database offline'); } };
  let now = start;
  const first = await ensureMaintenanceScheduler({ DATABASE_URL: 'postgres://serverdesk@localhost:5432/x' }, { database: broken, storage: {}, timers, clock: () => now, log: message => logs.push(message) });
  try {
    assert.ok(first);
    assert.equal(await ensureMaintenanceScheduler({ DATABASE_URL: 'postgres://serverdesk@localhost:5432/x' }), first, 'a second call (a module reload) returns the same scheduler');
    const [timeout] = timers.entries;
    assert.deepEqual([timers.entries.length, timeout.kind, timeout.ms, timeout.unref], [1, 'timeout', firstTickMs, true], 'the first tick 30 s after the start, unref');
    assert.equal(first.nextTickAt, start + 30_000);
    now += firstTickMs;
    timeout.fn();
    const [interval] = timers.live('interval');
    assert.deepEqual([interval.ms, interval.unref], [tickMs, true], 'then every 60 s, unref');
    assert.equal(first.nextTickAt, now + tickMs);
    await new Promise(resolve => setTimeout(resolve, 20));
    await first.tick();
    interval.fn();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(calls >= 2, 'every tick tries again');
    assert.deepEqual(logs, ['ServerDesk: Maintenance scheduler error: database offline'], 'the error is logged once');
  } finally {
    first?.stop();
    delete globalThis[key];
  }
  assert.equal(timers.live('interval').length, 0, 'stop clears the timers');
});

test('the alarm check runs on every tick, never overlaps, survives a failing run and waits for the migrations', async () => {
  await fixture(async ({ clock, logs, scheduler }) => {
    const timers = fakeTimers(), calls = [];
    let release, failNext = false;
    const sweep = async now => {
      calls.push(now);
      if (failNext) { failNext = false; throw new Error('database offline'); }
      await new Promise(resolve => { release = resolve; });
      return { status: 'ran', devices: 0, failed: 0 };
    };
    const instance = scheduler({ timers, sweep });
    instance.start();
    const [timeout] = timers.entries;
    clock.now += firstTickMs;
    timeout.fn();
    const settle = () => new Promise(resolve => setTimeout(resolve, 200));
    await settle();
    assert.deepEqual(calls, [start + firstTickMs], 'the first tick starts the check with the clock');
    const [interval] = timers.live('interval');
    clock.now += tickMs;
    interval.fn();
    await settle();
    assert.equal(calls.length, 1, 'a running check is never started twice');
    release();
    await settle();
    failNext = true;
    clock.now += tickMs;
    interval.fn();
    await settle();
    assert.equal(calls.length, 2);
    assert.deepEqual(logs.filter(line => line.includes('Alarm check')), ['ServerDesk: Alarm check error: database offline'], 'a failing check is logged');
    clock.now += tickMs;
    const next = instance.sweepTick();
    await settle();
    release();
    assert.deepEqual(await next, { status: 'ran', devices: 0, failed: 0 }, 'the next tick runs again');
    instance.stop();
    assert.equal(await instance.sweepTick(), null, 'no check after stop');
    // A database with pending migrations: the check waits.
    const waiting = scheduler({ timers: fakeTimers(), sweep, journal: { entries: [{ tag: '9999_not_applied' }] } });
    const before = calls.length;
    assert.equal(await waiting.sweepTick(), null);
    assert.equal(calls.length, before, 'no check while a migration is pending');
  });
});

test('the notification dispatcher runs right after the alarm check, also when the check fails, and never overlaps', async () => {
  await fixture(async ({ clock, logs, scheduler }) => {
    const order = [];
    let release, failSweep = false, failDispatch = false;
    const sweep = async now => { order.push(['sweep', now]); if (failSweep) throw new Error('sweep down'); return { status: 'ran', devices: 0, failed: 0 }; };
    const dispatch = async now => {
      order.push(['dispatch', now]);
      if (failDispatch) throw new Error('dispatch down');
      await new Promise(resolve => { release = resolve; });
    };
    const instance = scheduler({ timers: fakeTimers(), sweep, dispatch });
    const first = instance.sweepTick();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(order, [['sweep', start], ['dispatch', start]], 'the dispatcher follows the check with the same clock');
    assert.equal(await instance.sweepTick(), null, 'a running dispatch blocks the next tick');
    assert.equal(order.length, 2, 'no second check or dispatch while one runs');
    release();
    assert.deepEqual(await first, { status: 'ran', devices: 0, failed: 0 }, 'the tick resolves with the result of the check');
    failSweep = true; failDispatch = true; clock.now += tickMs;
    assert.equal(await instance.sweepTick(), null, 'a failed check gives null');
    assert.deepEqual(order.slice(2), [['sweep', start + tickMs], ['dispatch', start + tickMs]], 'the dispatcher still runs after a failed check');
    assert.deepEqual(logs.filter(line => /Alarm check|Notification dispatch/.test(line)), ['ServerDesk: Alarm check error: sweep down', 'ServerDesk: Notification dispatch error: dispatch down'], 'both failures are logged');
    const onlyDispatch = scheduler({ timers: fakeTimers(), dispatch: async now => { order.push(['alone', now]); } });
    await onlyDispatch.sweepTick();
    assert.deepEqual(order.at(-1), ['alone', start + tickMs], 'a dispatcher without a check also runs');
  });
});

test('without a sweep the scheduler runs maintenance only', async () => {
  await fixture(async ({ scheduler }) => {
    assert.equal(await scheduler().sweepTick(), null);
  });
});

test('the vulnerability check runs on its own busy flag, so a long run never blocks the alarm check or the dispatcher', async () => {
  await fixture(async ({ clock, logs, scheduler }) => {
    const timers = fakeTimers(), order = [];
    let release, failNext = false;
    const sweep = async now => { order.push(['sweep', now]); return { status: 'ran', devices: 0, failed: 0 }; };
    const dispatch = async now => { order.push(['dispatch', now]); };
    const vulnerabilities = async now => {
      order.push(['vulnerabilities', now]);
      if (failNext) { failNext = false; throw new Error('nvd down'); }
      await new Promise(resolve => { release = resolve; });
      return { status: 'ok' };
    };
    const instance = scheduler({ timers, sweep, dispatch, vulnerabilities });
    instance.start();
    const [timeout] = timers.entries;
    clock.now += firstTickMs;
    timeout.fn();
    const settle = () => new Promise(resolve => setTimeout(resolve, 200));
    await settle();
    assert.deepEqual(order.filter(([name]) => name === 'vulnerabilities'), [['vulnerabilities', start + firstTickMs]], 'the first tick starts the check with the clock');
    const [interval] = timers.live('interval');
    clock.now += tickMs;
    interval.fn();
    await settle();
    assert.deepEqual(order.filter(([name]) => name === 'vulnerabilities').length, 1, 'a running check is never started twice');
    assert.deepEqual(order.filter(([name]) => name === 'sweep').map(([, now]) => now), [start + firstTickMs, start + firstTickMs + tickMs], 'the alarm check runs on every tick while the vulnerability check is busy');
    assert.equal(order.filter(([name]) => name === 'dispatch').length, 2, 'and so does the dispatcher');
    release();
    await settle();
    failNext = true;
    assert.equal(await instance.vulnerabilityTick(), null, 'a failed check gives null');
    assert.deepEqual(logs.filter(line => line.includes('Vulnerability check')), ['ServerDesk: Vulnerability check error: nvd down'], 'and is logged');
    const next = instance.vulnerabilityTick();
    await settle();
    release();
    assert.deepEqual(await next, { status: 'ok' }, 'the next tick runs again');
    instance.stop();
    assert.equal(await instance.vulnerabilityTick(), null, 'no check after stop');
    const waiting = scheduler({ timers: fakeTimers(), vulnerabilities, journal: { entries: [{ tag: '9999_not_applied' }] } });
    const before = order.length;
    assert.equal(await waiting.vulnerabilityTick(), null);
    assert.equal(order.length, before, 'no check while a migration is pending');
    assert.equal(await scheduler().vulnerabilityTick(), null, 'nothing without the callback');
  });
});

test('a fresh installation that never checked starts one release check by itself at the release tick, under the lease, and only once', async () => {
  await fixture(async ({ database, storage, clock, scheduler }) => {
    const noTimers = { setInterval: () => null, clearInterval: () => {} }, lists = [];
    const fetch = async url => { lists.push(url); return Response.json([]); };
    const instance = scheduler({ releases: now => runReleaseCheck(database, { trigger: 'request', storage, fetch, clock: () => now, timers: noTimers, log: () => {} }) });
    assert.equal((await database.one(sql`SELECT last_started_at FROM agent_release_source WHERE id=1`)).last_started_at, null, 'a fresh installation never checked');
    // Another holder of the lease: the tick skips and the check stays due.
    await database.exec(sql`UPDATE agent_release_source SET lease_holder='other',lease_until=${clock.now + 60_000} WHERE id=1`);
    assert.deepEqual(await instance.releaseTick(), { status: 'skipped' });
    await database.exec(sql`UPDATE agent_release_source SET lease_holder=NULL,lease_until=NULL WHERE id=1`);
    assert.deepEqual(await instance.releaseTick(), { status: 'ok', imported: 0, present: 0, failed: 0, removedChunks: 0 }, 'without a request the first tick checks GitHub');
    assert.equal(lists.length, 1);
    assert.equal((await database.one(sql`SELECT last_started_at FROM agent_release_source WHERE id=1`)).last_started_at, clock.now);
    clock.now += tickMs;
    assert.deepEqual(await instance.releaseTick(), { status: 'not-requested' }, 'only once: then Check now and the daily maintenance decide');
    assert.equal(lists.length, 1);
  });
  // With MAINTENANCE_SCHEDULER=off no scheduler, so no tick and no check, starts.
  assert.equal(await ensureMaintenanceScheduler({ DATABASE_URL: 'postgres://serverdesk@localhost:5432/x', MAINTENANCE_SCHEDULER: 'off' }, { releases: async () => { throw new Error('no check without the scheduler'); } }), null);
});

test('the agent release check runs on its own busy flag, never overlaps itself and starts a requested check at the next tick', async () => {
  await fixture(async ({ database, storage, clock, logs, scheduler }) => {
    const timers = fakeTimers(), calls = [];
    let release;
    const releases = async now => { calls.push(now); await new Promise(resolve => { release = resolve; }); return { status: 'ok' }; };
    const instance = scheduler({ timers, releases });
    instance.start();
    clock.now += firstTickMs;
    timers.entries[0].fn();
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.deepEqual(calls, [start + firstTickMs], 'the first tick calls the release check with the clock');
    assert.equal(await instance.releaseTick(), null, 'a running check is never started twice');
    release();
    await new Promise(resolve => setTimeout(resolve, 50));
    const next = instance.releaseTick();
    await new Promise(resolve => setTimeout(resolve, 50));
    release();
    assert.deepEqual(await next, { status: 'ok' });
    instance.stop();
    // The real check: nothing without a request; a requested check starts and uses the request up.
    const noTimers = { setInterval: () => null, clearInterval: () => {} };
    const real = scheduler({ releases: now => runReleaseCheck(database, { trigger: 'request', storage, clock: () => now, timers: noTimers, log: () => {} }) });
    assert.deepEqual(await real.releaseTick(), { status: 'not-requested' });
    // The first tick also ran the daily maintenance, whose check started at that time; Check now comes later.
    clock.now += 5000;
    await database.exec(sql`UPDATE agent_release_source SET requested_at=${clock.now - 1000} WHERE id=1`);
    assert.deepEqual(await real.releaseTick(), { status: 'failed', imported: 0, present: 0, failed: 0, removedChunks: 0 }, 'offline the requested check fails as unreachable');
    assert.deepEqual(await database.one(sql`SELECT last_started_at,last_status,last_error FROM agent_release_source WHERE id=1`), { last_started_at: clock.now, last_status: 'failed', last_error: 'serverMessage.releaseImport.unreachable' });
    assert.deepEqual(await real.releaseTick(), { status: 'not-requested' }, 'the request is used up');
    const failing = scheduler({ releases: async () => { throw new Error('github down'); } });
    assert.equal(await failing.releaseTick(), null);
    assert.deepEqual(logs.filter(line => line.includes('Agent release check')), ['ServerDesk: Agent release check error: github down']);
    const waiting = scheduler({ releases, journal: { entries: [{ tag: '9999_not_applied' }] } });
    assert.equal(await waiting.releaseTick(), null, 'no check while a migration is pending');
    assert.equal(calls.length, 2);
    assert.equal(await scheduler().releaseTick(), null, 'nothing without the callback');
  });
});

test('the Entra account check runs on its own busy flag, never overlaps itself, waits for migrations and logs a repeated error once', async () => {
  await fixture(async ({ logs, scheduler, clock }) => {
    const timers = fakeTimers(), calls = [], sweeps = [];
    let finish;
    const entraCheck = async now => { calls.push(now); await new Promise(resolve => { finish = resolve; }); return { status: 'skipped' }; };
    const instance = scheduler({ timers, entraCheck, sweep: async now => { sweeps.push(now); return { status: 'ok' }; } });
    instance.start();
    clock.now += firstTickMs;
    timers.entries[0].fn();
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.deepEqual(calls, [start + firstTickMs], 'the first tick calls the account check with the clock');
    assert.equal(await instance.entraCheckTick(), null, 'a running check is never started twice');
    assert.deepEqual(await instance.sweepTick(), { status: 'ok' }, 'a running account check does not block the other ticks');
    assert.ok(sweeps.length >= 1);
    finish();
    await new Promise(resolve => setTimeout(resolve, 50));
    const next = instance.entraCheckTick();
    await new Promise(resolve => setTimeout(resolve, 50));
    finish();
    assert.deepEqual(await next, { status: 'skipped' }, 'the next tick runs it again');
    instance.stop();
    assert.equal(await instance.entraCheckTick(), null, 'nothing after stop');
    const failing = scheduler({ entraCheck: async () => { throw new Error('graph down'); } });
    assert.equal(await failing.entraCheckTick(), null, 'an error never rejects');
    assert.equal(await failing.entraCheckTick(), null);
    assert.deepEqual(logs.filter(line => line.includes('Entra account check')), ['ServerDesk: Entra account check error: graph down'], 'a repeated error is logged once');
    const waiting = scheduler({ entraCheck, journal: { entries: [{ tag: '9999_not_applied' }] } });
    assert.equal(await waiting.entraCheckTick(), null, 'no check while a migration is pending');
    assert.equal(calls.length, 2);
    assert.equal(await scheduler().entraCheckTick(), null, 'nothing without the callback');
  });
  assert.equal(await ensureMaintenanceScheduler({ DATABASE_URL: 'postgres://serverdesk@localhost:5432/x', MAINTENANCE_SCHEDULER: 'off' }, { entraCheck: async () => { throw new Error('no check without the scheduler'); } }), null, 'MAINTENANCE_SCHEDULER=off: no check');
});
