// No test reaches GitHub: the release check of a maintenance run fails as unreachable.
import '../support/offline-fetch.mjs';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {compile,createDatabase,sql,SqlFragment} from '../../runtime/database.mjs';
import { resultHasMore, startMaintenance } from '../../runtime/maintenance.mjs';
import { createStorage } from '../../runtime/storage.mjs';
import { maintenanceSelections, migrateDatabase, recordMaintenanceRun, resolveRetention, runMaintenance } from '../../scripts/selfhost.mjs';

import {createTrigger,dropTrigger,idents} from '../support/source-database.mjs';
import {enableMultipleCustomers} from '../support/customer-separation.mjs';
import { createTestDatabase, testDatabase } from '../support/postgres.mjs';
import { serverDeskRoot } from '../support/paths.mjs';
const projectRoot = serverDeskRoot;
const day = 86_400_000;
const now = Date.UTC(2026, 9, 16, 12);
const retention = { auditDays: 30, jobDays: 30 };

// Each case gets a migrated PostgreSQL test database and its own object folder.
// second() opens another pool on the same database: a second CLI process.
async function fixture(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'serverdesk-maintenance-'));
  const database = await testDatabase();
  const others = [];
  try {
    const storage = createStorage({ OBJECT_STORAGE_DRIVER: 'filesystem', OBJECT_STORAGE_PATH: path.join(directory, 'objects') });
    const second = () => { const other = createDatabase({ url: database.url, password: database.password, max: 4 }); others.push(other); return other; };
    return await run({ database, storage, directory, second });
  } finally {
    for (const other of others) await other.close().catch(() => {});
    await database.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

// A database handle that logs every statement (its text) and, per committed
// transaction, the text, bound values and row count of each statement.
function recording(database) {
  const statements = [], batches = [];
  const handle = (target, log) => {
    const run = kind => async statement => {
      const result = await target[kind](statement), { text, params } = compile(statement);
      statements.push(text);
      log?.push({ sql: text, values: params, changes: kind === 'exec' ? result.rowCount : kind === 'query' ? result.length : result === null ? 0 : 1 });
      return result;
    };
    return { query: run('query'), one: run('one'), exec: run('exec') };
  };
  const recorded = {
    ...handle(database, null),
    async transaction(callback, options) {
      let log;
      const result = await database.transaction(tx => { log = []; return callback(handle(tx, log)); }, options);
      batches.push(log);
      return result;
    },
    close: async () => {},
  };
  return { database: recorded, statements, batches };
}

// The rows of maintenance_runs, oldest first.
const runsOf = async database => (await database.query(sql`SELECT id,started_at,finished_at,status,result,error FROM maintenance_runs ORDER BY id`));
// A short-lived pool on the database of a CLI test ({url, password}).
async function withDatabase(target, task) {
  const database = createDatabase({ url: target.url, password: target.password, max: 1 });
  try { return await task(database); } finally { await database.close(); }
}
const recordedRuns = target => withDatabase(target, runsOf);

const insertAudit = (database, at, scope = 'portal', serverId = null) =>
  database.exec(sql`INSERT INTO audit(at,actor,action,target,server_id,scope) VALUES(${at},${'tester'},${'test.action'},${'target'},${serverId},${scope})`);
const insertJob = (database, createdAt, state, serverId = 'device-a') => {
  const id = randomUUID();
  return database.exec(sql`INSERT INTO jobs(id,server_id,action,target,state,created_at,actor) VALUES(${id},${serverId},${'refresh'},${'target'},${state},${createdAt},${'tester'})`).then(() => id);
};
const insertOutput = (database, createdAt) => {
  const id = randomUUID();
  return database.exec(sql`INSERT INTO job_outputs(job_id,server_id,data,created_at) VALUES(${id},${'device-a'},${'{}'},${createdAt})`).then(() => id);
};
async function insertTransfer(database, storage, { serverId = 'device-a', state, expiresAt, updatedAt = now - day, message = null, chunks = 2 }) {
  const id = randomUUID();
  await database.exec(sql`INSERT INTO transfers(id,server_id,principal,direction,path,size,sha256,state,overwrite,created_at,updated_at,expires_at,message) VALUES(${id},${serverId},${'private:tester'},${'upload'},${'C:\\Temp\\file.bin'},${10},${'a'.repeat(64)},${state},0,${now - 2 * day},${updatedAt},${expiresAt},${message})`);
  for (let chunk = 0; chunk < chunks; chunk++) {
    const sha = String(chunk).repeat(64);
    await database.exec(sql`INSERT INTO transfer_chunks(id,transfer_id,chunk,size,sha256) VALUES(${`${id}:${chunk}`},${id},${chunk},${5},${sha})`);
    await storage.put(`transfers/${id}/${chunk}/${sha}`, 'chunk');
  }
  return id;
}
const transferRow = (database, id) => database.one(sql`SELECT state,updated_at,message FROM transfers WHERE id=${id}`);
const chunkCount = (database, id) => database.one(sql`SELECT count(*) AS n FROM transfer_chunks WHERE transfer_id=${id}`).then(row=>row===null?null:row.n);
const objectKeys = async (storage, prefix = '') => (await storage.list({ prefix })).objects.map(object => object.key);
// text is fixture SQL without values.
const ids = async (database, text) => (await database.query(new SqlFragment([text], []))).map(row => Object.values(row)[0]);

const summaryAction = 'Audit retention applied';
const summaries = async database => (await database.query(sql`SELECT at,actor,action,target,server_id,scope FROM audit WHERE action=${summaryAction} ORDER BY id`));
const summaryTarget = (cutoff, days, deleted) => `Cutoff ${new Date(cutoff).toISOString()}, retention ${days} ${days === 1 ? 'day' : 'days'}, deleted rows: ${deleted}`;
const summaryCount = summary => Number(/deleted rows: (\d+)$/.exec(summary.target)[1]);
const plainAuditCount = database => database.one(sql`SELECT count(*) AS n FROM audit WHERE action <> ${summaryAction}`).then(row=>row===null?null:row.n);

async function dump(database, storage) {
  const tables = {};
  for (const [table, order] of [['audit', 'id'], ['jobs', 'id'], ['job_outputs', 'job_id'], ['transfers', 'id'], ['transfer_chunks', 'id']]) {
    tables[table] = (await database.query(sql`SELECT * FROM ${sql.ident(table)} ORDER BY ${idents(order)}`));
  }
  return { tables, objects: await objectKeys(storage) };
}

test('audit retention deletes exactly the rows older than auditDays regardless of scope and device', async () => {
  await fixture(async ({ database, storage }) => {
    await insertAudit(database, now - 40 * day, 'portal');
    await insertAudit(database, now - 31 * day, 'device', 'device-b');
    await insertAudit(database, now - 29 * day, 'device', 'device-a');
    const previous = process.env.AUDIT_RETENTION_DAYS;
    process.env.AUDIT_RETENTION_DAYS = '1';
    let result;
    try { result = await runMaintenance(database, storage, { retention, now }); } finally {
      if (previous === undefined) delete process.env.AUDIT_RETENTION_DAYS; else process.env.AUDIT_RETENTION_DAYS = previous;
    }
    assert.deepEqual(result.audit, { deleted: 2, more: false });
    assert.deepEqual(result.retention, { ...retention, softwareDays: 365, alertDays: 90 }, 'runMaintenance ignores AUDIT_RETENTION_DAYS and uses the passed retention');
    assert.deepEqual(await ids(database, `SELECT at FROM audit WHERE action <> '${summaryAction}'`), [now - 29 * day]);
    assert.deepEqual(await summaries(database), [{
      at: now, actor: 'System', action: summaryAction,
      target: 'Cutoff 2026-09-16T12:00:00.000Z, retention 30 days, deleted rows: 2',
      server_id: null, scope: 'portal',
    }]);
    assert.doesNotThrow(() => JSON.stringify(result));
    // customerAudit lists the passes of customers with their own retention; none here.
    assert.deepEqual(Object.keys(result), ['retention', 'audit', 'customerAudit', 'jobs', 'jobOutputs', 'assistantScripts', 'softwareChanges', 'alerts', 'notifications', 'integrityEvents', 'transfers']);
    assert.deepEqual(result.customerAudit, []);
  });
});

test('a retention of one day is named in the singular', async () => {
  await fixture(async ({ database, storage }) => {
    await insertAudit(database, now - 2 * day);
    const result = await runMaintenance(database, storage, { retention: { auditDays: 1, jobDays: 30 }, now });
    assert.deepEqual(result.audit, { deleted: 1, more: false });
    assert.deepEqual((await summaries(database)).map(row => row.target), ['Cutoff 2026-10-15T12:00:00.000Z, retention 1 day, deleted rows: 1']);
  });
});

test('a run whose last batch deletes nothing still records the rows of earlier batches', async () => {
  await fixture(async ({ database, storage }) => {
    for (let index = 0; index < 4; index++) await insertAudit(database, now - (40 + index) * day);
    const result = await runMaintenance(database, storage, { retention, now, batchSize: 2, maxBatches: 5 });
    assert.deepEqual(result.audit, { deleted: 4, more: false });
    assert.deepEqual((await summaries(database)).map(row => row.target), [summaryTarget(now - 30 * day, 30, 4)]);
    assert.equal(await plainAuditCount(database), 0);
  });
});

test('a run without audit deletions writes no summary row', async () => {
  await fixture(async ({ database, storage }) => {
    await insertAudit(database, now - day);
    await insertAudit(database, now - 29 * day);
    const result = await runMaintenance(database, storage, { retention, now });
    assert.deepEqual(result.audit, { deleted: 0, more: false });
    assert.deepEqual(await summaries(database), []);
    assert.equal(await database.one(sql`SELECT count(*) AS n FROM audit`).then(row=>row===null?null:row.n), 2);
  });
});

test('a failing summary row rolls back the last audit deletion and stops the run', async () => {
  await fixture(async ({ database, storage }) => {
    for (let index = 0; index < 3; index++) await insertAudit(database, now - (40 + index) * day);
    const job = await insertJob(database, now - 40 * day, 'succeeded');
    const transfer = await insertTransfer(database, storage, { state: 'cancelled', expiresAt: now + day, updatedAt: now - 3 * day });
    await createTrigger(database, 'fail_summary', 'audit', 'BEFORE INSERT', { message: 'audit unavailable', when: "NEW.actor='System'" });
    const before = await dump(database, storage);
    await assert.rejects(runMaintenance(database, storage, { retention, now, batchSize: 500 }), error => /audit unavailable/.test(error.message));
    assert.deepEqual(await dump(database, storage), before, 'audit rows, the job and the transfer with chunks and objects stay unchanged');
    assert.equal(await plainAuditCount(database), 3);
    assert.deepEqual(await ids(database, 'SELECT id FROM jobs'), [job]);
    assert.equal((await transferRow(database, transfer)).state, 'cancelled');
    assert.equal(await chunkCount(database, transfer), 2);
    assert.equal((await objectKeys(storage, `transfers/${transfer}/`)).length, 2);
    assert.deepEqual(await summaries(database), []);

    await dropTrigger(database, 'fail_summary');
    const retry = await runMaintenance(database, storage, { retention, now, batchSize: 500 });
    assert.deepEqual(retry.audit, { deleted: 3, more: false });
    assert.equal(await plainAuditCount(database), 0);
    assert.deepEqual((await summaries(database)).map(row => row.target), [summaryTarget(now - 30 * day, 30, 3)]);
  });
});

test('job retention keeps pending and running jobs and deletes old job outputs', async () => {
  await fixture(async ({ database, storage }) => {
    const old = now - 31 * day, young = now - 29 * day;
    for (const state of ['succeeded', 'failed', 'expired', 'cancelled']) await insertJob(database, old, state, state === 'failed' ? 'device-b' : 'device-a');
    const kept = [await insertJob(database, old, 'pending'), await insertJob(database, old, 'running'), await insertJob(database, young, 'succeeded')];
    await insertOutput(database, old);
    const youngOutput = await insertOutput(database, young);
    const result = await runMaintenance(database, storage, { retention: { auditDays: 30, jobDays: 30 }, now });
    assert.deepEqual(result.jobs, { deleted: 4, more: false });
    assert.deepEqual(result.jobOutputs, { deleted: 1, more: false });
    assert.deepEqual((await ids(database, 'SELECT id FROM jobs')).sort(), kept.sort());
    assert.deepEqual(await ids(database, 'SELECT job_id FROM job_outputs'), [youngOutput]);
  });
});

test('a longer job retention keeps job outputs for the same number of days', async () => {
  await fixture(async ({ database, storage }) => {
    const kept = await insertOutput(database, now - 40 * day);
    await insertOutput(database, now - 91 * day);
    const result = await runMaintenance(database, storage, { retention: { auditDays: 30, jobDays: 90 }, now });
    assert.deepEqual(result.jobOutputs, { deleted: 1, more: false });
    assert.deepEqual(await ids(database, 'SELECT job_id FROM job_outputs'), [kept]);
  });
});

test('job and audit retention use their own limits', async () => {
  await fixture(async ({ database, storage }) => {
    await insertAudit(database, now - 10 * day);
    await insertJob(database, now - 10 * day, 'succeeded');
    const result = await runMaintenance(database, storage, { retention: { auditDays: 30, jobDays: 7 }, now });
    assert.equal(result.audit.deleted, 0);
    assert.equal(result.jobs.deleted, 1);
  });
});

test('deletions run in bounded batches and a later run continues', async () => {
  await fixture(async ({ database, storage }) => {
    for (let index = 0; index < 7; index++) await insertAudit(database, now - (40 + index) * day);
    await insertAudit(database, now - day);
    // Log each transaction with the rows every statement changed. Only the last
    // audit delete transaction of a run writes the summary.
    const log = recording(database), { statements } = log;
    const batches = log.batches;
    const isAuditInsert = ({ sql }) => /^\s*INSERT INTO audit\b/i.test(sql);
    // The delete names its table as a quoted identifier.
    const isAuditDelete = ({ sql }) => /^\s*DELETE FROM "?audit"?\s/i.test(sql);
    const checkSummaryBatch = () => {
      const writing = batches.map((entries, index) => ({ entries, index })).filter(({ entries }) => entries.some(entry => isAuditInsert(entry) && entry.changes > 0));
      assert.equal(writing.length, 1, 'exactly one batch of the run writes a summary row');
      const [{ entries, index }] = writing;
      const deleteAt = entries.findIndex(isAuditDelete), insertAt = entries.findIndex(entry => isAuditInsert(entry) && entry.changes > 0);
      assert.ok(deleteAt >= 0 && deleteAt < insertAt, 'the summary follows a DELETE FROM audit in the same batch');
      assert.equal(entries[insertAt].changes, 1);
      assert.equal(index, batches.findLastIndex(list => list.some(isAuditDelete)), 'the summary is in the last audit delete batch');
      batches.length = 0;
    };
    {
      const first = await runMaintenance(log.database, storage, { retention, now, batchSize: 2, maxBatches: 2 });
      assert.deepEqual(first.audit, { deleted: 4, more: true });
      checkSummaryBatch();
      assert.deepEqual((await summaries(database)).map(summaryCount), [4]);
      const second = await runMaintenance(log.database, storage, { retention, now, batchSize: 2, maxBatches: 2 });
      assert.deepEqual(second.audit, { deleted: 3, more: false });
      checkSummaryBatch();
      assert.deepEqual((await summaries(database)).map(summaryCount), [4, 3]);
    }
    assert.equal(await plainAuditCount(database), 1);
    assert.equal((await summaries(database)).length, 2, 'summary rows are not older than the cutoff and stay');
    for (const sql of statements.filter(sql => /^\s*DELETE/i.test(sql))) {
      assert.match(sql, /IN \(SELECT .+ LIMIT \$\d+\)$/, `delete is bounded by a LIMIT: ${sql}`);
    }
  });
});

test('selection queries search the retention indexes instead of scanning tables', async () => {
  await fixture(async ({ database }) => {
    // Both audit selections search (customer_id, at), the instance one with customer_id IS NULL.
    const expected = { audit: ['audit', 'idx_audit_customer_at'], customerAudit: ['audit', 'idx_audit_customer_at'], jobs: ['jobs', 'idx_jobs_created_at'], jobOutputs: ['job_outputs', 'idx_job_outputs_created_at'], assistantScripts: ['jobs', 'idx_jobs_assistant_script'], transfers: ['transfers', 'idx_transfers_state_expiry'], softwareChanges: ['device_software_changes', 'idx_device_software_changes_at'], alerts: ['alerts', 'idx_alerts_closed_at'], notifications: ['notification_events', 'idx_notification_events_occurred'], integrityEvents: ['agent_integrity_events', 'idx_agent_integrity_events_received'] };
    assert.deepEqual(Object.keys(maintenanceSelections).sort(), Object.keys(expected).sort());
    // A sequential scan is forbidden for the plan, so it shows whether the index serves the selection.
    const plan = statement => database.transaction(async tx => { await tx.exec(sql`SET LOCAL enable_seqscan=off`); return (await tx.query(sql`EXPLAIN ${statement}`)).map(row => row['QUERY PLAN']).join('\n'); });
    for (const [name, [table, index]] of Object.entries(expected)) {
      const indexes = (await database.query(sql`SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename=${table}`)).map(row => row.indexname);
      assert.ok(indexes.includes(index), `${index} exists after migration`);
      const values = name === 'customerAudit' ? ['00000000-0000-4000-8000-000000000100', now, 10] : [now, 10];
      const text = await plan(maintenanceSelections[name](...values));
      assert.match(text, new RegExp(`(Index (Only )?Scan using|Bitmap Index Scan on) ${index}\\b`), `${name}: ${text}`);
      assert.doesNotMatch(text, new RegExp(`Seq Scan on ${table}\\b`), `${name}: ${text}`);
    }
  });
});

test('transfers of every device are cleared while active ones stay untouched', async () => {
  await fixture(async ({ database, storage }) => {
    await database.exec(sql`INSERT INTO servers(id,name,token_hash,created_at,last_seen,revoked) VALUES(${'device-off'},${'Offline'},${'x'.repeat(64)},${now - 90 * day},${now - 60 * day},1)`);
    await database.exec(sql`INSERT INTO servers(id,name,token_hash,created_at,last_seen) VALUES(${'device-a'},${'Online'},${'y'.repeat(64)},${now - 90 * day},${now})`);
    const elapsed = await insertTransfer(database, storage, { serverId: 'device-off', state: 'active', expiresAt: now - 1, updatedAt: now - 5 * day });
    const cancelled = await insertTransfer(database, storage, { serverId: 'device-a', state: 'cancelled', expiresAt: now + day, message: 'Benutzerrechte geändert', updatedAt: now - 4 * day });
    const failed = await insertTransfer(database, storage, { serverId: 'device-off', state: 'failed', expiresAt: now + day, updatedAt: now - 3 * day });
    const expired = await insertTransfer(database, storage, { serverId: 'device-off', state: 'expired', expiresAt: now - 10 * day, updatedAt: now - 9 * day });
    const uploading = await insertTransfer(database, storage, { serverId: 'device-off', state: 'uploading', expiresAt: now + day });
    const ready = await insertTransfer(database, storage, { serverId: 'device-off', state: 'ready', expiresAt: now });
    await storage.put('releases/foreign/object', 'keep');
    const untouched = {};
    for (const id of [expired, uploading, ready]) untouched[id] = { row: await transferRow(database, id), chunks: await chunkCount(database, id), objects: await objectKeys(storage, `transfers/${id}/`) };

    const result = await runMaintenance(database, storage, { retention, now });
    assert.deepEqual(result.transfers, { cleared: 3, failed: 0, more: false });
    for (const id of [elapsed, cancelled, failed]) {
      const row = await transferRow(database, id);
      assert.equal(row.state, 'expired');
      assert.equal(row.updated_at, now);
      assert.equal(row.message, id === cancelled ? 'Benutzerrechte geändert' : 'Zwischenspeicher abgelaufen');
      assert.equal(await chunkCount(database, id), 0);
      assert.deepEqual(await objectKeys(storage, `transfers/${id}/`), []);
    }
    for (const [id, before] of Object.entries(untouched)) {
      assert.deepEqual({ row: await transferRow(database, id), chunks: await chunkCount(database, id), objects: await objectKeys(storage, `transfers/${id}/`) }, before);
      assert.equal(before.objects.length, 2);
    }
    assert.deepEqual(await objectKeys(storage, 'releases/'), ['releases/foreign/object']);
  });
});

test('transfer cleanup is limited per run and oldest updates go first', async () => {
  await fixture(async ({ database, storage }) => {
    const newest = await insertTransfer(database, storage, { state: 'cancelled', expiresAt: now + day, updatedAt: now - day });
    const oldest = await insertTransfer(database, storage, { state: 'failed', expiresAt: now + day, updatedAt: now - 3 * day });
    await insertTransfer(database, storage, { state: 'completed', expiresAt: now - day, updatedAt: now - 2 * day });
    const first = await runMaintenance(database, storage, { retention, now, transferLimit: 1 });
    assert.deepEqual(first.transfers, { cleared: 1, failed: 0, more: true });
    assert.equal((await transferRow(database, oldest)).state, 'expired');
    assert.equal((await transferRow(database, newest)).state, 'cancelled');
    const second = await runMaintenance(database, storage, { retention, now, transferLimit: 2 });
    assert.deepEqual(second.transfers, { cleared: 2, failed: 0, more: false });
  });
});

test('a storage failure leaves that transfer unchanged and a later run retries it', async () => {
  await fixture(async ({ database, storage }) => {
    const broken = await insertTransfer(database, storage, { state: 'cancelled', expiresAt: now + day, updatedAt: now - 3 * day });
    const healthy = await insertTransfer(database, storage, { state: 'failed', expiresAt: now + day, updatedAt: now - 2 * day });
    const failing = { ...storage, async delete(keys) {
      if ([keys].flat().some(key => key.startsWith(`transfers/${broken}/`))) throw new Error('storage offline');
      return storage.delete(keys);
    } };
    const before = await transferRow(database, broken);
    const first = await runMaintenance(database, failing, { retention, now });
    assert.deepEqual(first.transfers, { cleared: 1, failed: 1, more: false });
    const after = await transferRow(database, broken);
    assert.deepEqual({ state: after.state, message: after.message }, { state: before.state, message: before.message });
    assert.ok(after.updated_at > before.updated_at, 'a failed transfer queues behind the others');
    assert.equal(await chunkCount(database, broken), 2);
    assert.equal((await objectKeys(storage, `transfers/${broken}/`)).length, 2);
    assert.equal((await transferRow(database, healthy)).state, 'expired');
    const second = await runMaintenance(database, storage, { retention, now });
    assert.deepEqual(second.transfers, { cleared: 1, failed: 0, more: false });
    assert.equal((await transferRow(database, broken)).state, 'expired');
    assert.equal(await chunkCount(database, broken), 0);
    assert.deepEqual(await objectKeys(storage, `transfers/${broken}/`), []);
  });
});

async function seedEverything(database, storage) {
  for (let index = 0; index < 5; index++) {
    await insertAudit(database, now - (31 + index) * day);
    await insertJob(database, now - (31 + index) * day, 'succeeded');
    await insertOutput(database, now - (31 + index) * day);
    await insertTransfer(database, storage, { state: index % 2 ? 'cancelled' : 'active', expiresAt: index % 2 ? now + day : now - day, updatedAt: now - index * day });
  }
  await insertAudit(database, now - day);
  await insertJob(database, now - day, 'succeeded');
  await insertJob(database, now - 40 * day, 'running');
  await insertTransfer(database, storage, { state: 'ready', expiresAt: now + day });
}

// Row counts per table; audit counts only rows other than summary rows, whose
// number depends on how many of the concurrent runs deleted something.
const counted = state => ({
  counts: Object.fromEntries(Object.entries(state.tables).map(([table, rows]) => [table, (table === 'audit' ? rows.filter(row => row.action !== summaryAction) : rows).length])),
  objects: state.objects.length,
  states: state.tables.transfers.map(row => row.state).sort(),
});

test('a second run changes nothing and concurrent runs reach the same state', async () => {
  let single;
  await fixture(async ({ database, storage }) => {
    await seedEverything(database, storage);
    await runMaintenance(database, storage, { retention, now, batchSize: 2 });
    const state = await dump(database, storage);
    const again = await runMaintenance(database, storage, { retention, now, batchSize: 2 });
    assert.deepEqual(again, { retention: { ...retention, softwareDays: 365, alertDays: 90 }, audit: { deleted: 0, more: false }, customerAudit: [], jobs: { deleted: 0, more: false }, jobOutputs: { deleted: 0, more: false }, assistantScripts: { cleared: 0, more: false }, softwareChanges: { deleted: 0, more: false }, alerts: { deleted: 0, more: false }, notifications: { deleted: 0, more: false }, integrityEvents: { deleted: 0, more: false }, transfers: { cleared: 0, failed: 0, more: false } });
    assert.deepEqual(await dump(database, storage), state);
    single = counted(state);
  });
  await fixture(async ({ database, storage, second }) => {
    await seedEverything(database, storage);
    // A second pool on the same database behaves like a second CLI process.
    const other = second();
    {
      const results = await Promise.all([
        runMaintenance(database, storage, { retention, now, batchSize: 2 }),
        runMaintenance(other, storage, { retention, now, batchSize: 2 }),
      ]);
      assert.equal(results.reduce((sum, result) => sum + result.transfers.failed, 0), 0);
      assert.equal(results.reduce((sum, result) => sum + result.audit.deleted, 0), 5);
      assert.equal(results.reduce((sum, result) => sum + result.transfers.cleared, 0), 5, 'each transfer is cleared by exactly one run');
      const recorded = await summaries(database);
      assert.equal(recorded.length, results.filter(result => result.audit.deleted > 0).length, 'each deleting run writes exactly one summary row');
      assert.equal(recorded.reduce((sum, row) => sum + summaryCount(row), 0), 5);
    }
    const state = await dump(database, storage);
    assert.deepEqual(counted(state), single);
  });
});

test('resolveRetention prefers flags over environment over 30 days and rejects invalid values', () => {
  assert.deepEqual(resolveRetention(), { auditDays: 30, jobDays: 30, softwareDays: 365, alertDays: 90 });
  assert.deepEqual(resolveRetention({ env: { AUDIT_RETENTION_DAYS: '90', JOB_RETENTION_DAYS: '14' } }), { auditDays: 90, jobDays: 14, softwareDays: 365, alertDays: 90 });
  assert.deepEqual(resolveRetention({ args: { '--audit-days': '365' }, env: { AUDIT_RETENTION_DAYS: '90', JOB_RETENTION_DAYS: '14' } }), { auditDays: 365, jobDays: 14, softwareDays: 365, alertDays: 90 });
  assert.deepEqual(resolveRetention({ args: { '--job-days': '1' }, env: { JOB_RETENTION_DAYS: '3650' } }), { auditDays: 30, jobDays: 1, softwareDays: 365, alertDays: 90 });
  assert.deepEqual(resolveRetention({ env: { AUDIT_RETENTION_DAYS: '' } }), { auditDays: 30, jobDays: 30, softwareDays: 365, alertDays: 90 });
  // The software change history: flag, then SOFTWARE_CHANGE_RETENTION_DAYS, then 365 days.
  assert.deepEqual(resolveRetention({ env: { SOFTWARE_CHANGE_RETENTION_DAYS: '90' } }).softwareDays, 90);
  assert.deepEqual(resolveRetention({ args: { '--software-days': '7' }, env: { SOFTWARE_CHANGE_RETENTION_DAYS: '90' } }).softwareDays, 7);
  assert.deepEqual(resolveRetention({ env: { SOFTWARE_CHANGE_RETENTION_DAYS: '' } }).softwareDays, 365);
  for (const value of ['0', '3651', '1.5', 'abc', '-1', ' 30']) {
    assert.throws(() => resolveRetention({ args: { '--audit-days': value } }), { message: '--audit-days: enter a whole number of days from 1 to 3650.' });
    assert.throws(() => resolveRetention({ args: { '--job-days': value } }), { message: '--job-days: enter a whole number of days from 1 to 3650.' });
    assert.throws(() => resolveRetention({ env: { AUDIT_RETENTION_DAYS: value } }), { message: 'AUDIT_RETENTION_DAYS: enter a whole number of days from 1 to 3650.' });
    assert.throws(() => resolveRetention({ env: { JOB_RETENTION_DAYS: value } }), { message: 'JOB_RETENTION_DAYS: enter a whole number of days from 1 to 3650.' });
    assert.throws(() => resolveRetention({ args: { '--software-days': value } }), { message: '--software-days: enter a whole number of days from 1 to 3650.' });
    assert.throws(() => resolveRetention({ env: { SOFTWARE_CHANGE_RETENTION_DAYS: value } }), { message: 'SOFTWARE_CHANGE_RETENTION_DAYS: enter a whole number of days from 1 to 3650.' });
  }
  assert.throws(() => resolveRetention({ args: { '--audit-days': '45' }, env: { JOB_RETENTION_DAYS: 'x' } }), { message: 'JOB_RETENTION_DAYS: enter a whole number of days from 1 to 3650.' });
});

test('the software change history is deleted after softwareDays in bounded batches', async () => {
  await fixture(async ({ database, storage }) => {
    await database.exec(sql`INSERT INTO servers(id,name,token_hash,created_at,last_seen) VALUES(${'device-sw'},${'Software'},${'s'.repeat(64)},${now - 900 * day},${now})`);
    for (const age of [400, 366, 364, 10]) await database.exec(sql`INSERT INTO device_software_changes(server_id,at,change,name,normalized_name,version_to,scope) VALUES(${'device-sw'},${now - age * day},'installed',${'App ' + age},${'app ' + age},'1.0','machine')`);
    const result = await runMaintenance(database, storage, { retention, now, batchSize: 1 });
    assert.deepEqual(result.retention, { auditDays: 30, jobDays: 30, softwareDays: 365, alertDays: 90 });
    assert.deepEqual(result.softwareChanges, { deleted: 2, more: false });
    const kept = (await database.query(sql`SELECT name FROM device_software_changes ORDER BY at`)).map(row => row.name);
    assert.deepEqual(kept, ['App 364', 'App 10']);
    const shorter = await runMaintenance(database, storage, { retention: { ...retention, softwareDays: 30, alertDays: 90 }, now });
    assert.deepEqual(shorter.softwareChanges, { deleted: 1, more: false });
    await assert.rejects(runMaintenance(database, storage, { retention: { ...retention, softwareDays: 0 }, now }));
  });
});

test('closed alarms are deleted after alertDays; open, pending and newer closed alarms stay', async () => {
  await fixture(async ({ database, storage }) => {
    await database.exec(sql`INSERT INTO servers(id,name,token_hash,created_at,last_seen) VALUES(${'device-alarm'},${'Alarm'},${'a'.repeat(64)},${now - 900 * day},${now})`);
    const alarm = (id, state, ruleId, age, closedAge) => database.exec(sql`INSERT INTO alerts(id,server_id,rule_id,key,state,level,peak_level,params,started_at,opened_at,closed_at,close_reason)
      VALUES(${id},'device-alarm',${ruleId},${ruleId},${state},'warning','warning','{}',${now - age * day},${state === 'pending' ? null : now - age * day}::bigint,${closedAge === null ? null : now - closedAge * day}::bigint,${closedAge === null ? null : 'recovered'}::text)`);
    await alarm('closed-old', 'closed', 'cpu', 200, 91);
    await alarm('closed-older', 'closed', 'memory', 300, 120);
    await alarm('closed-new', 'closed', 'pagefile', 100, 89);
    await alarm('open-old', 'open', 'reboot-pending', 400, null);
    await alarm('pending-old', 'pending', 'disk-latency', 400, null);
    const result = await runMaintenance(database, storage, { retention, now, batchSize: 1 });
    assert.equal(result.retention.alertDays, 90, 'the default is 90 days');
    assert.deepEqual(result.alerts, { deleted: 2, more: false });
    assert.deepEqual((await database.query(sql`SELECT id FROM alerts ORDER BY id`)).map(row => row.id), ['closed-new', 'open-old', 'pending-old'], 'open, pending and newer closed alarms stay');
    const limited = await runMaintenance(database, storage, { retention: { ...retention, alertDays: 30 }, now, batchSize: 1, maxBatches: 1 });
    assert.deepEqual(limited.alerts, { deleted: 1, more: false }, 'alertDays 30 deletes the newer closed alarm');
    assert.equal(resultHasMore({ alerts: { deleted: 500, more: true } }), true, 'remaining alarms start a continuation');
    await assert.rejects(runMaintenance(database, storage, { retention: { ...retention, alertDays: 3651 }, now }));
  });
});

test('notification events go after alertDays with their deliveries; pending events and open deliveries stay', async () => {
  await fixture(async ({ database, storage }) => {
    const event = (id, age, status = 'routed') => database.exec(sql`INSERT INTO notification_events(id,alert_id,server_id,kind,level,occurred_at,status,suppressed_reason)
      VALUES(${id},${'alarm-' + id},'device-x','open','warning',${now - age * day},${status},${status === 'suppressed' ? 'no-rule' : null}::text)`);
    const delivery = (id, eventId, status) => database.exec(sql`INSERT INTO notification_deliveries(id,event_id,channel_name,channel_type,target_hint,status,attempts,sent_at,claimed_by,claimed_at,created_at)
      VALUES(${id},${eventId},'Ops','webhook','https://x/…',${status},1,${status === 'sent' ? now : null}::bigint,${status === 'sending' ? 'run' : null}::text,${status === 'sending' ? now : null}::bigint,${now})`);
    await event('old-sent', 120); await delivery('d-old-sent', 'old-sent', 'sent');
    await event('old-suppressed', 100, 'suppressed');
    await event('old-pending', 100, 'pending');
    await event('old-retrying', 100); await delivery('d-old-retrying', 'old-retrying', 'pending');
    await event('old-sending', 100); await delivery('d-old-sending', 'old-sending', 'sending');
    await event('new-sent', 10); await delivery('d-new-sent', 'new-sent', 'sent');
    await database.exec(sql`INSERT INTO notification_events(id,kind,occurred_at,status) VALUES('old-test','test',${now - 95 * day},'routed')`);
    const result = await runMaintenance(database, storage, { retention, now, batchSize: 1 });
    assert.deepEqual(result.notifications, { deleted: 3, more: false }, 'the old sent, suppressed and test events');
    assert.deepEqual((await database.query(sql`SELECT id FROM notification_events ORDER BY id`)).map(row => row.id), ['new-sent', 'old-pending', 'old-retrying', 'old-sending'], 'pending events, open deliveries and newer events stay');
    assert.deepEqual((await database.query(sql`SELECT id FROM notification_deliveries ORDER BY id`)).map(row => row.id), ['d-new-sent', 'd-old-retrying', 'd-old-sending'], 'the deliveries go with their event');
    const limited = await runMaintenance(database, storage, { retention: { ...retention, alertDays: 5 }, now, batchSize: 1, maxBatches: 1 });
    assert.deepEqual(limited.notifications, { deleted: 1, more: false }, 'alertDays 5 deletes the newer sent event');
    assert.equal(resultHasMore({ notifications: { deleted: 500, more: true } }), true, 'remaining events start a continuation');
  });
});

test('--alert-days and ALERT_RETENTION_DAYS: flag, then environment, then 90 days, from 1 to 3650', () => {
  assert.equal(resolveRetention().alertDays, 90);
  assert.equal(resolveRetention({ env: { ALERT_RETENTION_DAYS: '365' } }).alertDays, 365);
  assert.equal(resolveRetention({ args: { '--alert-days': '7' }, env: { ALERT_RETENTION_DAYS: '365' } }).alertDays, 7);
  assert.equal(resolveRetention({ env: { ALERT_RETENTION_DAYS: '' } }).alertDays, 90);
  assert.equal(resolveRetention({ env: { ALERT_RETENTION_DAYS: '1' }, stored: { auditDays: 40, jobDays: 50 } }).alertDays, 1, 'no stored step');
  for (const value of ['0', '3651', 'abc', '1.5']) {
    assert.throws(() => resolveRetention({ args: { '--alert-days': value } }), { message: '--alert-days: enter a whole number of days from 1 to 3650.' });
    assert.throws(() => resolveRetention({ env: { ALERT_RETENTION_DAYS: value } }), { message: 'ALERT_RETENTION_DAYS: enter a whole number of days from 1 to 3650.' });
  }
});

test('remaining software changes start a continuation like the other areas', () => {
  const done = { deleted: 0, more: false };
  const base = { audit: done, customerAudit: [], jobs: done, jobOutputs: done, softwareChanges: done, transfers: { cleared: 0, failed: 0, more: false } };
  assert.equal(resultHasMore(base), false);
  assert.equal(resultHasMore({ ...base, softwareChanges: { deleted: 500, more: true } }), true);
});

test('runMaintenance rejects an invalid retention before changing data', async () => {
  await fixture(async ({ database, storage }) => {
    await insertAudit(database, now - 40 * day);
    await assert.rejects(runMaintenance(database, storage, { retention: { auditDays: 0, jobDays: 30 }, now }));
    await assert.rejects(runMaintenance(database, storage, { now }));
    assert.equal(await database.one(sql`SELECT count(*) AS n FROM audit`).then(row=>row===null?null:row.n), 1);
  });
});

test('maintenance CLI checks migrations, prints JSON and rejects bad arguments', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'serverdesk-maintenance-cli-'));
  const target = await createTestDatabase({ template: false });
  const environment = { ...process.env, DATABASE_URL: target.url, DATABASE_PASSWORD: target.password, OBJECT_STORAGE_DRIVER: 'filesystem', OBJECT_STORAGE_PATH: path.join(directory, 'objects') };
  delete environment.AUDIT_RETENTION_DAYS;
  delete environment.JOB_RETENTION_DAYS;
  delete environment.SOFTWARE_CHANGE_RETENTION_DAYS;
  const cli = (args, env = environment) => spawnSync(process.execPath, ['--import', './tests/support/offline-fetch.mjs', 'scripts/selfhost.mjs', ...args], { cwd: projectRoot, env, encoding: 'utf8', timeout: 60000 });
  try {
    const unmigrated = cli(['maintenance']);
    assert.equal(unmigrated.status, 1, unmigrated.stderr);
    assert.match(unmigrated.stderr, /^ServerDesk: Apply all migrations with the command migrate before maintenance\./m);
    assert.equal(unmigrated.stdout, '');
    assert.equal(await withDatabase(target, database => database.one(sql`SELECT to_regclass('public.maintenance_runs') AS name`)).then(row => row.name), null, 'no table and no row before migrate');

    assert.equal(cli(['migrate']).status, 0);
    const success = cli(['maintenance', '--audit-days', '60', '--job-days', '7']);
    assert.equal(success.status, 0, success.stderr);
    const output = JSON.parse(success.stdout);
    assert.deepEqual(Object.keys(output), ['retention', 'audit', 'customerAudit', 'jobs', 'jobOutputs', 'assistantScripts', 'softwareChanges', 'alerts', 'notifications', 'integrityEvents', 'transfers', 'usageReport', 'releaseImport']);
    assert.deepEqual(output.retention, { auditDays: 60, jobDays: 7, softwareDays: 365, alertDays: 90 });
    assert.deepEqual(output.usageReport, { status: 'disabled' }, 'usage data is off in this version');
    // The CLI run checks GitHub too; without network the check fails and the run still succeeds.
    assert.deepEqual(output.releaseImport, { status: 'failed', imported: 0, present: 0, failed: 0, removedChunks: 0 });
    assert.deepEqual(await withDatabase(target, database => database.one(sql`SELECT last_status,last_error,lease_holder FROM agent_release_source WHERE id=1`)),
      { last_status: 'failed', last_error: 'serverMessage.releaseImport.unreachable', lease_holder: null });
    assert.deepEqual(output.transfers, { cleared: 0, failed: 0, more: false });
    // The run left exactly one succeeded row with the printed result.
    const [recorded, ...others] = await recordedRuns(target);
    assert.deepEqual(others, []);
    assert.equal(recorded.status, 'succeeded');
    assert.deepEqual(JSON.parse(recorded.result), output);
    assert.equal(recorded.error, null);
    assert.ok(recorded.started_at <= recorded.finished_at);

    const fromEnvironment = cli(['maintenance'], { ...environment, AUDIT_RETENTION_DAYS: '90' });
    assert.equal(fromEnvironment.status, 0, fromEnvironment.stderr);
    assert.deepEqual(JSON.parse(fromEnvironment.stdout).retention, { auditDays: 90, jobDays: 30, softwareDays: 365, alertDays: 90 });
    const software = cli(['maintenance', '--software-days', '30'], { ...environment, SOFTWARE_CHANGE_RETENTION_DAYS: '90' });
    assert.equal(software.status, 0, software.stderr);
    assert.deepEqual(JSON.parse(software.stdout).retention, { auditDays: 30, jobDays: 30, softwareDays: 30, alertDays: 90 });

    for (const [args, flag] of [[['--bogus', '1'], '--bogus'], [['--audit-days'], '--audit-days'], [['--audit-days', '--job-days', '5'], '--audit-days'], [['--job-days', '5', '--job-days', '6'], '--job-days']]) {
      const rejected = cli(['maintenance', ...args]);
      assert.equal(rejected.status, 1, args.join(' '));
      assert.match(rejected.stderr, new RegExp(`^ServerDesk: Invalid or incomplete argument: ${flag}$`, 'm'));
    }
    const invalid = cli(['maintenance', '--audit-days', '0']);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /^ServerDesk: --audit-days: enter a whole number of days from 1 to 3650\.$/m);
    const invalidEnvironment = cli(['maintenance'], { ...environment, JOB_RETENTION_DAYS: 'abc' });
    assert.equal(invalidEnvironment.status, 1);
    assert.match(invalidEnvironment.stderr, /^ServerDesk: JOB_RETENTION_DAYS: enter a whole number of days from 1 to 3650\.$/m);

    const help = cli(['--help']);
    assert.equal(help.status, 0);
    assert.ok(help.stdout.includes('       node --env-file=.env.local scripts/selfhost.mjs maintenance [--audit-days 30] [--job-days 30] [--software-days 365] [--alert-days 90]'));

    // Rejected arguments never reach the run; a missing
    // migration stops it before it records anything, although the table exists.
    const before = await recordedRuns(target);
    assert.equal(before.length, 3, 'only the three runs that started are recorded');
    await withDatabase(target, database => database.exec(sql`DELETE FROM _serverdesk_migrations WHERE name=(SELECT max(name) FROM _serverdesk_migrations)`));
    const pending = cli(['maintenance']);
    assert.equal(pending.status, 1);
    assert.match(pending.stderr, /^ServerDesk: Apply all migrations with the command migrate before maintenance\./m);
    assert.deepEqual(await recordedRuns(target), before);
  } finally {
    await target.drop();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// ---- Audit retention per customer -------------------------------------------
// Customer A keeps 7 days, B 90 days (disabled), C has no own value and follows
// the instance default of 30 days, like rows without customer.
const customerA = '00000000-0000-4000-8000-0000000000a1';
const customerB = '00000000-0000-4000-8000-0000000000b2';
const customerC = '00000000-0000-4000-8000-0000000000c3';
const ages = [5, 20, 60, 120];
async function seedCustomers(database) {
  await database.exec(enableMultipleCustomers());
  await database.exec(sql`INSERT INTO customers(id,name,status,created_at,updated_at,audit_retention_days) VALUES
    (${customerA},'Kunde A','active',1,1,7),(${customerB},'Kunde B','active',1,1,90),(${customerC},'Kunde C','active',1,1,NULL)`);
  for (const customer of [customerA, customerB, customerC]) {
    const device = `device-${customer.slice(-2)}`;
    await database.exec(sql`INSERT INTO servers(id,name,token_hash,created_at,customer_id) VALUES(${device},${device},${'x'.repeat(64)},${now - 200 * day},${customer})`);
    for (const age of ages) {
      await insertAudit(database, now - age * day, 'device', device);
      await database.exec(sql`INSERT INTO audit(at,actor,action,target,server_id,scope,customer_id) VALUES(${now - age * day},'tester','Runbook kundenübergreifend gestartet','target',NULL,'portal',${customer})`);
    }
  }
  // The retention also applies to a disabled customer.
  await database.exec(sql`UPDATE customers SET status='disabled' WHERE id=${customerB}`);
  for (const age of ages) await insertAudit(database, now - age * day);
}
// Remaining ages per owner of a row ('none' = no customer), summary rows left out.
async function remaining(database) {
  const rows = (await database.query(sql`SELECT at,customer_id FROM audit WHERE action <> ${summaryAction} ORDER BY at`));
  const owners = { [customerA]: [], [customerB]: [], [customerC]: [], none: [] };
  for (const row of rows) owners[row.customer_id ?? 'none'].push(Math.round((now - row.at) / day));
  return owners;
}
const customerSummaries = async database => (await database.query(sql`SELECT target,server_id,scope,customer_id FROM audit WHERE action=${summaryAction} ORDER BY customer_id IS NOT NULL,customer_id,id`));
const twice = list => list.flatMap(age => [age, age]);

test('each customer with its own retention keeps exactly its days, everything else the instance default', async () => {
  await fixture(async ({ database, storage }) => {
    await seedCustomers(database);
    assert.equal(await database.one(sql`SELECT count(*) AS n FROM audit WHERE customer_id=${customerA} AND server_id IS NOT NULL`).then(row=>row===null?null:row.n), 4, 'device rows carry their customer through the trigger');
    const result = await runMaintenance(database, storage, { retention, now });
    assert.deepEqual(Object.keys(result), ['retention', 'audit', 'customerAudit', 'jobs', 'jobOutputs', 'assistantScripts', 'softwareChanges', 'alerts', 'notifications', 'integrityEvents', 'transfers']);
    assert.deepEqual(result.retention, { ...retention, softwareDays: 365, alertDays: 90 });
    assert.deepEqual(result.audit, { deleted: 6, more: false }, 'instance pass: C and rows without customer older than 30 days');
    assert.deepEqual(result.customerAudit, [
      { customerId: customerA, auditDays: 7, deleted: 6, more: false },
      { customerId: customerB, auditDays: 90, deleted: 2, more: false },
    ]);
    assert.deepEqual(await remaining(database), { [customerA]: twice([5]), [customerB]: twice([60, 20, 5]), [customerC]: twice([20, 5]), none: [20, 5] });
    assert.deepEqual(await customerSummaries(database), [
      { target: summaryTarget(now - 30 * day, 30, 6), server_id: null, scope: 'portal', customer_id: null },
      { target: summaryTarget(now - 7 * day, 7, 6), server_id: null, scope: 'portal', customer_id: customerA },
      { target: summaryTarget(now - 90 * day, 90, 2), server_id: null, scope: 'portal', customer_id: customerB },
    ]);
  });
});

test('--audit-days and AUDIT_RETENTION_DAYS change the instance default, never a customer value', async () => {
  for (const source of [{ args: { '--audit-days': '1' } }, { env: { AUDIT_RETENTION_DAYS: '1' } }]) {
    await fixture(async ({ database, storage }) => {
      await seedCustomers(database);
      const result = await runMaintenance(database, storage, { retention: resolveRetention(source), now });
      assert.deepEqual(result.retention, { auditDays: 1, jobDays: 30, softwareDays: 365, alertDays: 90 });
      assert.deepEqual(result.audit, { deleted: 12, more: false });
      assert.deepEqual(result.customerAudit.map(({ customerId, auditDays, deleted }) => [customerId, auditDays, deleted]), [[customerA, 7, 6], [customerB, 90, 2]]);
      const owners = await remaining(database);
      assert.deepEqual([owners[customerA], owners[customerB], owners[customerC], owners.none], [twice([5]), twice([60, 20, 5]), [], []]);
    });
  }
});

test('a pass without deletions writes no summary; without own retention customerAudit stays empty', async () => {
  await fixture(async ({ database, storage }) => {
    await database.exec(enableMultipleCustomers());
    await database.exec(sql`INSERT INTO customers(id,name,status,created_at,updated_at,audit_retention_days) VALUES(${customerA},'Kunde A','active',1,1,7)`);
    await insertAudit(database, now - 40 * day);
    const result = await runMaintenance(database, storage, { retention, now });
    assert.deepEqual(result.customerAudit, [{ customerId: customerA, auditDays: 7, deleted: 0, more: false }]);
    assert.deepEqual((await customerSummaries(database)).map(row => row.customer_id), [null], 'only the instance pass deleted something');
    await database.exec(sql`UPDATE customers SET audit_retention_days=NULL WHERE id=${customerA}`);
    assert.deepEqual((await runMaintenance(database, storage, { retention, now })).customerAudit, []);
  });
});

test('every customer audit summary is in the last batch of its pass, right after a DELETE FROM audit', async () => {
  await fixture(async ({ database, storage }) => {
    await seedCustomers(database);
    // Every transaction entry carries its bound values, so it names its pass.
    const log = recording(database), { batches } = log;
    const own = [customerA, customerB];
    const isDelete = entry => /^\s*DELETE FROM "?audit"?\s/i.test(entry.sql), isInsert = entry => /^\s*INSERT INTO audit\b/i.test(entry.sql);
    const passOf = entry => isDelete(entry)
      ? (/customer_id = \$\d+/.test(entry.sql) && own.includes(entry.values[0]) ? entry.values[0] : 'instance')
      : (/customer_id\)/.test(entry.sql) ? entry.values[3] ?? 'instance' : 'instance');
    await runMaintenance(log.database, storage, { retention, now, batchSize: 2 });
    const writing = batches.map((entries, index) => ({ entries, index })).filter(({ entries }) => entries.some(entry => isInsert(entry) && entry.changes > 0));
    assert.deepEqual(writing.map(({ entries }) => passOf(entries.find(isInsert))), ['instance', customerA, customerB], 'one summary per pass');
    for (const { entries, index } of writing) {
      const insertAt = entries.findIndex(entry => isInsert(entry) && entry.changes > 0), pass = passOf(entries[insertAt]);
      assert.ok(insertAt > 0 && isDelete(entries[insertAt - 1]) && passOf(entries[insertAt - 1]) === pass, `${pass}: the summary follows a DELETE of its pass`);
      assert.equal(index, batches.findLastIndex(list => list.some(entry => isDelete(entry) && passOf(entry) === pass)), `${pass}: the summary is in the last batch of its pass`);
    }
    assert.deepEqual((await customerSummaries(database)).map(summaryCount), [6, 6, 2]);
  });
});

test('a failing customer summary rolls back its last deletion and leaves jobs and transfers untouched', async () => {
  await fixture(async ({ database, storage }) => {
    await seedCustomers(database);
    const job = await insertJob(database, now - 40 * day, 'succeeded');
    const transfer = await insertTransfer(database, storage, { state: 'cancelled', expiresAt: now + day, updatedAt: now - 3 * day });
    await createTrigger(database, 'fail_customer_summary', 'audit', 'BEFORE INSERT', { message: 'customer audit unavailable', when: `NEW.actor='System' AND NEW.customer_id='${customerA}'` });
    await assert.rejects(runMaintenance(database, storage, { retention, now }), error => /customer audit unavailable/.test(error.message));
    assert.deepEqual((await remaining(database))[customerA], twice([120, 60, 20, 5]), 'the rows of A stay');
    assert.deepEqual(await ids(database, 'SELECT id FROM jobs'), [job]);
    assert.equal((await transferRow(database, transfer)).state, 'cancelled');
    assert.equal(await chunkCount(database, transfer), 2);
    assert.equal((await objectKeys(storage, `transfers/${transfer}/`)).length, 2);
    assert.deepEqual((await customerSummaries(database)).map(row => row.customer_id), [null], 'the instance pass before it stays recorded');
    await dropTrigger(database, 'fail_customer_summary');
    const retry = await runMaintenance(database, storage, { retention, now });
    assert.deepEqual(retry.customerAudit.map(entry => entry.deleted), [6, 2]);
    assert.deepEqual(retry.transfers, { cleared: 1, failed: 0, more: false });
  });
});

test('with customer retention a second run changes nothing and concurrent runs reach the same state', async () => {
  let single;
  await fixture(async ({ database, storage }) => {
    await seedCustomers(database);
    await runMaintenance(database, storage, { retention, now, batchSize: 2 });
    const state = await dump(database, storage);
    const again = await runMaintenance(database, storage, { retention, now, batchSize: 2 });
    assert.deepEqual(again.audit, { deleted: 0, more: false });
    assert.deepEqual(again.customerAudit, [{ customerId: customerA, auditDays: 7, deleted: 0, more: false }, { customerId: customerB, auditDays: 90, deleted: 0, more: false }]);
    assert.deepEqual(await dump(database, storage), state);
    single = await remaining(database);
  });
  await fixture(async ({ database, storage, second }) => {
    await seedCustomers(database);
    const other = second();
    {
      const results = await Promise.all([
        runMaintenance(database, storage, { retention, now, batchSize: 2 }),
        runMaintenance(other, storage, { retention, now, batchSize: 2 }),
      ]);
      assert.equal(results.reduce((sum, result) => sum + result.audit.deleted, 0), 6);
      for (const [index, customer] of [customerA, customerB].entries()) {
        const deleted = results.map(result => result.customerAudit[index].deleted), expected = index === 0 ? 6 : 2;
        assert.equal(deleted[0] + deleted[1], expected, `${customer}: each row is deleted once`);
        const recorded = (await customerSummaries(database)).filter(row => row.customer_id === customer);
        assert.equal(recorded.length, deleted.filter(count => count > 0).length, `${customer}: one summary per deleting run`);
        assert.equal(recorded.reduce((sum, row) => sum + summaryCount(row), 0), expected);
      }
    }
    assert.deepEqual(await remaining(database), single);
  });
});

// ---- Every run is recorded in maintenance_runs ---------------------------------
// recordMaintenanceRun wraps the work of the maintenance command; the clock is
// fixed, and each call of it moves one millisecond on.
const steppingClock = (start = now) => { let tick = start; return () => tick++; };
const withReport = (result, usageReport = { status: 'disabled' }) => ({ ...result, usageReport });

test('a successful run is recorded with its result', async () => {
  await fixture(async ({ database, storage }) => {
    await insertAudit(database, now - 40 * day);
    const output = await recordMaintenanceRun(database, async () => withReport(await runMaintenance(database, storage, { retention, now })), { clock: steppingClock() });
    assert.deepEqual(Object.keys(output), ['retention', 'audit', 'customerAudit', 'jobs', 'jobOutputs', 'assistantScripts', 'softwareChanges', 'alerts', 'notifications', 'integrityEvents', 'transfers', 'usageReport']);
    const rows = await runsOf(database);
    assert.equal(rows.length, 1);
    const [row] = rows;
    assert.equal(row.status, 'succeeded');
    assert.equal(row.started_at, now);
    assert.equal(row.finished_at, now + 1);
    assert.deepEqual(JSON.parse(row.result), output, 'the whole return value, usageReport included');
    assert.equal(row.error, null);

    // A failed or skipped usage report does not make the run a failure.
    for (const usageReport of [{ status: 'failed', error: 'http-503' }, { status: 'invalid-server' }, { status: 'not-due' }]) {
      await recordMaintenanceRun(database, async () => withReport(await runMaintenance(database, storage, { retention, now }), usageReport), { clock: steppingClock() });
      const last = (await runsOf(database)).at(-1);
      assert.equal(last.status, 'succeeded', usageReport.status);
      assert.deepEqual(JSON.parse(last.result).usageReport, usageReport);
    }
  });
});

test('a run with failed transfers is recorded as failed', async () => {
  await fixture(async ({ database, storage }) => {
    const broken = await insertTransfer(database, storage, { state: 'cancelled', expiresAt: now + day, updatedAt: now - 3 * day });
    const failing = { ...storage, async delete(keys) {
      if ([keys].flat().some(key => key.startsWith(`transfers/${broken}/`))) throw new Error('storage offline');
      return storage.delete(keys);
    } };
    const output = await recordMaintenanceRun(database, async () => withReport(await runMaintenance(database, failing, { retention, now })), { clock: steppingClock() });
    assert.deepEqual(output.transfers, { cleared: 0, failed: 1, more: false });
    const [row] = await runsOf(database);
    assert.equal(row.status, 'failed');
    assert.equal(row.error, 'serverMessage.maintenance.transfersFailed', 'the row stores the reason key; the text stays the stderr line');
    assert.deepEqual(JSON.parse(row.result), output);
    assert.equal(row.finished_at, now + 1);
  });
});

test('a throwing run is recorded as failed and rethrown', async () => {
  await fixture(async ({ database, storage }) => {
    await insertAudit(database, now - 40 * day);
    await createTrigger(database, 'fail_summary', 'audit', 'BEFORE INSERT', { message: 'audit unavailable', when: "NEW.actor='System'" });
    let reported = false;
    await assert.rejects(recordMaintenanceRun(database, async () => {
      const result = await runMaintenance(database, storage, { retention, now });
      reported = true;
      return withReport(result);
    }, { clock: steppingClock() }), error => /audit unavailable/.test(error.message));
    assert.equal(reported, false, 'no usage report after a throwing run');
    const [row] = await runsOf(database);
    assert.equal(row.status, 'failed');
    assert.equal(row.result, null);
    assert.equal(row.error, 'serverMessage.maintenance.internal', 'an unclassified error stores internal, never its message');
    assert.equal(row.finished_at, now + 1);

    // Any thrown error stores internal; the original error is rethrown unchanged.
    const long = new Error('x'.repeat(2000));
    await assert.rejects(recordMaintenanceRun(database, async () => { throw long; }), error => error === long);
    const last = (await runsOf(database)).at(-1);
    assert.deepEqual([last.status, last.result, last.error], ['failed', null, 'serverMessage.maintenance.internal']);
    // A marked error stores its reason.
    await assert.rejects(recordMaintenanceRun(database, async () => resolveRetention({ env: { AUDIT_RETENTION_DAYS: 'abc' } })), { message: 'AUDIT_RETENTION_DAYS: enter a whole number of days from 1 to 3650.' });
    assert.equal((await runsOf(database)).at(-1).error, 'serverMessage.maintenance.retentionInvalid');
  });
});

test('the table rejects invalid rows', async () => {
  await fixture(async ({ database }) => {
    const insert = (status, finishedAt, result = null, error = null) => database.exec(sql`INSERT INTO maintenance_runs(started_at,finished_at,status,result,error) VALUES(${now},${finishedAt},${status},${result},${error})`);
    for (const [label, row] of [
      ['an unknown status', ['done', now]],
      ['running with finished_at', ['running', now]],
      ['succeeded without finished_at', ['succeeded', null]],
      ['failed without finished_at', ['failed', null]],
      ['a result that is no JSON', ['succeeded', now, '{']],
      ['an error over 500 characters', ['failed', now, null, 'x'.repeat(501)]],
    ]) await assert.rejects(insert(...row), error=>error.code==='23514', label);
    await insert('running', null);
    await insert('succeeded', now, '{"ok":true}');
    await insert('failed', now, null, 'x'.repeat(500));
    assert.equal((await runsOf(database)).length, 3);
    assert.match((await database.one(sql`SELECT indexdef FROM pg_indexes WHERE indexname='maintenance_runs_finished'`)).indexdef, /\(status, finished_at\)$/);
  });
});

test('concurrent runs each record their own row', async () => {
  await fixture(async ({ database, second }) => {
    // A second pool on the same database behaves like a second CLI process.
    const other = second();
    {
      // Both runs are 'running' before either finishes.
      let started = 0, release;
      const gate = new Promise(resolve => { release = resolve; });
      const work = name => async () => { if (++started === 2) release(); await gate; return { name, transfers: { cleared: 0, failed: 0, more: false } }; };
      await Promise.all([
        recordMaintenanceRun(database, work('first'), { clock: steppingClock(now) }),
        recordMaintenanceRun(other, work('second'), { clock: steppingClock(now + 1000) }),
      ]);
    }
    const rows = await runsOf(database);
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0].id, rows[1].id);
    assert.ok(rows.every(row => row.status === 'succeeded' && row.error === null));
    // Each run finished exactly the row it started.
    assert.deepEqual(Object.fromEntries(rows.map(row => [row.started_at, JSON.parse(row.result).name])), { [now]: 'first', [now + 1000]: 'second' });
    assert.deepEqual(rows.map(row => row.finished_at - row.started_at), [1, 1]);
  });
});

// The app writes while maintenance runs: an open app transaction with an audit
// row in another pool. PostgreSQL has no database-wide write lock, so the
// maintenance CLI does not wait for it; both commit.
test('maintenance runs while an app transaction is open and both commit', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'serverdesk-maintenance-busy-'));
  const target = await createTestDatabase({ template: false });
  const environment = { ...process.env, DATABASE_URL: target.url, DATABASE_PASSWORD: target.password, OBJECT_STORAGE_DRIVER: 'filesystem', OBJECT_STORAGE_PATH: path.join(directory, 'objects') };
  delete environment.LICENSE_SERVER_URL;
  const app = createDatabase({ url: target.url, password: target.password, max: 1 });
  try {
    await migrateDatabase(app);
    let release, locked;
    const held = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { locked = resolve; });
    const writing = app.transaction(async tx => {
      await tx.exec(sql`INSERT INTO audit(at,actor,action,target,scope) VALUES (${now},'app','App write','busy','portal')`);
      locked();
      await held;
    });
    await ready;
    const cli = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', './tests/support/offline-fetch.mjs', 'scripts/selfhost.mjs', 'maintenance'], { cwd: projectRoot, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', status => resolve({ status, stdout, stderr }));
    });
    release();
    await writing;
    assert.equal(cli.status, 0, cli.stderr);
    const [row, ...others] = await recordedRuns(target);
    assert.deepEqual(others, []);
    assert.equal(row.status, 'succeeded');
    assert.deepEqual(JSON.parse(row.result), JSON.parse(cli.stdout));
    assert.equal(await withDatabase(target, database => database.one(sql`SELECT count(*) AS n FROM audit WHERE actor='app'`).then(row=>row===null?null:row.n)), 1, 'the app write committed as well');
  } finally {
    await app.close();
    await target.drop();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// ---- The CLI shares the lock and the stored retention of the portal ----------------
test('resolveRetention takes the flag, then the stored setting, then the environment, then 30 days', () => {
  const env = { AUDIT_RETENTION_DAYS: '15', JOB_RETENTION_DAYS: '20' };
  assert.deepEqual(resolveRetention({ env, stored: { auditDays: 40, jobDays: null } }), { auditDays: 40, jobDays: 20, softwareDays: 365, alertDays: 90 }, 'a stored value beats the environment');
  assert.deepEqual(resolveRetention({ args: { '--audit-days': '5' }, env, stored: { auditDays: 40, jobDays: 50 } }), { auditDays: 5, jobDays: 50, softwareDays: 365, alertDays: 90 }, 'a flag beats the stored value');
  assert.deepEqual(resolveRetention({ env: { AUDIT_RETENTION_DAYS: 'abc' }, stored: { auditDays: 40, jobDays: 50 } }), { auditDays: 40, jobDays: 50, softwareDays: 365, alertDays: 90 }, 'with a stored value the variable has no effect');
  // The software change retention has no stored setting: flag, then environment, then 365 days.
  assert.deepEqual(resolveRetention({ env: { SOFTWARE_CHANGE_RETENTION_DAYS: '90' }, stored: { auditDays: 40, jobDays: 50 } }).softwareDays, 90, 'the stored settings leave the software retention to the environment');
  assert.deepEqual(resolveRetention({ args: { '--software-days': '7' }, env: { SOFTWARE_CHANGE_RETENTION_DAYS: '90' }, stored: { auditDays: 40, jobDays: 50 } }).softwareDays, 7, 'a flag beats the environment');
  assert.throws(() => resolveRetention({ env: { AUDIT_RETENTION_DAYS: 'abc' }, stored: { auditDays: null, jobDays: null } }), { message: 'AUDIT_RETENTION_DAYS: enter a whole number of days from 1 to 3650.' });
});

test('maintenance CLI takes the lock, writes trigger cli, refuses a held lock and applies flag, stored setting and environment in order', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'serverdesk-maintenance-lock-'));
  const target = await createTestDatabase();
  const environment = { ...process.env, DATABASE_URL: target.url, DATABASE_PASSWORD: target.password, OBJECT_STORAGE_DRIVER: 'filesystem', OBJECT_STORAGE_PATH: path.join(directory, 'objects') };
  delete environment.AUDIT_RETENTION_DAYS;
  delete environment.JOB_RETENTION_DAYS;
  delete environment.SOFTWARE_CHANGE_RETENTION_DAYS;
  delete environment.LICENSE_SERVER_URL;
  const cli = (args, env = environment) => spawnSync(process.execPath, ['--import', './tests/support/offline-fetch.mjs', 'scripts/selfhost.mjs', ...args], { cwd: projectRoot, env, encoding: 'utf8', timeout: 60000 });
  const rows = () => withDatabase(target, database => database.query(sql`SELECT status,trigger,requested_by,result FROM maintenance_runs ORDER BY id`));
  try {
    const first = cli(['maintenance']);
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual((await rows()).map(row => [row.status, row.trigger, row.requested_by]), [['succeeded', 'cli', null]]);
    assert.deepEqual(await withDatabase(target, database => database.one(sql`SELECT holder,run_id,expires_at FROM maintenance_lock`)), { holder: null, run_id: null, expires_at: null }, 'the CLI clears the lock');

    await withDatabase(target, database => database.exec(sql`UPDATE maintenance_lock SET holder='portal:1:live',acquired_at=${Date.now()},expires_at=${Date.now() + 600_000} WHERE id=1`));
    const held = cli(['maintenance']);
    assert.equal(held.status, 1);
    assert.match(held.stderr, /^ServerDesk: Maintenance is already running on another instance\. Try again later\.$/m);
    assert.equal(held.stdout, '');
    assert.equal((await rows()).length, 1, 'a held lock writes no row');
    await withDatabase(target, database => database.exec(sql`UPDATE maintenance_lock SET holder=NULL,acquired_at=NULL,expires_at=NULL WHERE id=1`));

    await withDatabase(target, database => database.exec(sql`UPDATE maintenance_settings SET audit_days=40,job_days=NULL WHERE id=1`));
    const stored = cli(['maintenance'], { ...environment, AUDIT_RETENTION_DAYS: '15', JOB_RETENTION_DAYS: '20' });
    assert.equal(stored.status, 0, stored.stderr);
    assert.deepEqual(JSON.parse(stored.stdout).retention, { auditDays: 40, jobDays: 20, softwareDays: 365, alertDays: 90 }, 'stored beats environment, environment beats 30');
    const flagged = cli(['maintenance', '--audit-days', '7'], { ...environment, AUDIT_RETENTION_DAYS: '15' });
    assert.equal(flagged.status, 0, flagged.stderr);
    assert.deepEqual(JSON.parse(flagged.stdout).retention, { auditDays: 7, jobDays: 30, softwareDays: 365, alertDays: 90 }, 'a flag beats the stored setting');
    const ignored = cli(['maintenance'], { ...environment, AUDIT_RETENTION_DAYS: 'abc' });
    assert.equal(ignored.status, 0, 'an invalid variable behind a stored value has no effect');
    assert.equal(await withDatabase(target, database => database.one(sql`SELECT audit_days FROM maintenance_settings`)).then(row => row.audit_days), 40, 'a flag is never stored');
    assert.deepEqual((await rows()).map(row => row.trigger), ['cli', 'cli', 'cli', 'cli']);

    // A thrown error: the row stores the reason key, stderr keeps the raw message, exit code 1.
    await withDatabase(target, async database => {
      await insertAudit(database, Date.now() - 400 * day);
      await createTrigger(database, 'fail_cli_summary', 'audit', 'BEFORE INSERT', { message: 'audit unavailable', when: "NEW.actor='System'" });
    });
    const thrown = cli(['maintenance']);
    await withDatabase(target, database => dropTrigger(database, 'fail_cli_summary', 'audit'));
    assert.equal(thrown.status, 1);
    const failed = (await withDatabase(target, database => database.query(sql`SELECT id,status,error FROM maintenance_runs ORDER BY id`))).at(-1);
    assert.deepEqual([failed.status, failed.error], ['failed', 'serverMessage.maintenance.internal']);
    assert.match(thrown.stderr, new RegExp(`^ServerDesk: Maintenance run ${failed.id} failed: audit unavailable$`, 'm'), 'the log line names the run and the raw message');
    assert.match(thrown.stderr, /^ServerDesk: audit unavailable$/m, 'the CLI still prints the raw message');
    assert.equal(await withDatabase(target, database => database.one(sql`SELECT count(*)::int AS n FROM audit WHERE action='Maintenance run started'`)).then(row => row.n), 0, 'CLI runs write no Run now audit row');
  } finally {
    await target.drop();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('the agent release check never changes the run status: a failing and a throwing check both leave the run succeeded', async () => {
  await fixture(async ({ database, storage }) => {
    const notices = [];
    const run = async () => (await startMaintenance(database, { trigger: 'cli', retention, storage, env: {}, notice: message => notices.push(message) })).finished;
    let outcome = await run();
    assert.deepEqual([outcome.status, outcome.result.releaseImport], ['succeeded', { status: 'failed', imported: 0, present: 0, failed: 0, removedChunks: 0 }], 'a failed check (offline)');
    await database.exec(sql`ALTER TABLE agent_release_source RENAME TO agent_release_source_away`);
    try { outcome = await run(); } finally { await database.exec(sql`ALTER TABLE agent_release_source_away RENAME TO agent_release_source`); }
    assert.deepEqual([outcome.status, outcome.result.releaseImport], ['succeeded', { status: 'failed', imported: 0, present: 0, failed: 0, removedChunks: 0 }], 'a throwing check');
    assert.equal(notices.filter(message => message.startsWith('The agent release check failed (')).length, 1, 'the error is noticed once');
    const rows = await database.query(sql`SELECT status,result FROM maintenance_runs ORDER BY id`);
    assert.deepEqual(rows.map(row => [row.status, JSON.parse(row.result).releaseImport.status]), [['succeeded', 'failed'], ['succeeded', 'failed']]);
  });
});
