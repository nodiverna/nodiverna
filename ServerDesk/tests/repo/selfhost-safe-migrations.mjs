// Safe migrations: the backup before the first pending migration (written
// once, never overwritten, with its .sha256), no migration after a failed
// backup, --skip-backup with its notice, no backup for an empty database or
// without pending migrations, and the schema lock against a migrated database.
// The pending migration is a second test migration next to a copy of the
// baseline in a temporary directory. pg_dump itself is replaced by a writer of
// a fixture file (backup.dump); the failing case uses the real dumpDatabase
// with PG_BIN_DIR on a pg_dump that fails or does not exist. The real dump
// and restore run in tests/integration/selfhost-backup.mjs and pnpm pipeline smoke.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sql } from '../../runtime/database.mjs';
import { migrateDatabase, schemaLock } from '../../scripts/selfhost.mjs';
import { testDatabase } from '../support/postgres.mjs';

const shipped = fileURLToPath(new URL('../../drizzle/', import.meta.url));
const lockFile = path.join(shipped, 'schema.lock.sql');
const pending = '0001_safe_probe.sql';
const time = new Date(Date.UTC(2031, 5, 1, 12, 30, 45));
const stamp = '20310601T123045Z';

async function temporaryDirectory(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'serverdesk-safe-migrations-'));
  try { return await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

/** An empty test database migrated from a copy of the baseline; then a second migration is pending. */
async function pendingFixture(run) {
  await temporaryDirectory(async directory => {
    const migrations = path.join(directory, 'drizzle'), backups = path.join(directory, 'backups');
    await mkdir(migrations);
    await cp(path.join(shipped, '0000_baseline.sql'), path.join(migrations, '0000_baseline.sql'));
    const database = await testDatabase({ template: false });
    try {
      assert.deepEqual(await migrateDatabase(database, { directory: migrations }), { applied: 1, total: 1 });
      await writeFile(path.join(migrations, pending), 'CREATE TABLE safe_probe(value text);');
      await run({ database, migrations, backups, directory });
    } finally { await database.close(); }
  });
}

const journalNames = async database => (await database.query(sql`SELECT name FROM _serverdesk_migrations ORDER BY name`)).map(row => row.name);
const exists = async (database, name) => (await database.one(sql`SELECT to_regclass(${'public.' + name}) IS NOT NULL AS found`)).found;
// A pg_dump stand-in: writes a fixture file and its .sha256 like dumpDatabase, and refuses an existing file.
const dumps = [];
const fakeDump = async (database, { file, url, password }) => {
  dumps.push({ file, url, password });
  const body = `fixture dump of ${path.basename(file)}`, digest = createHash('sha256').update(body).digest('hex');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body, { flag: 'wx' });
  await writeFile(file + '.sha256', `${digest}  ${path.basename(file)}\n`, { flag: 'wx' });
  return { file, sha256: digest, bytes: Buffer.byteLength(body) };
};

test('migrate writes a backup with its .sha256 before the first pending migration', async () => {
  await pendingFixture(async ({ database, migrations, backups }) => {
    const notices = [];
    dumps.length = 0;
    const result = await migrateDatabase(database, { directory: migrations, backup: { url: database.url, password: database.password, directory: backups, dump: fakeDump }, notice: message => notices.push(message), clock: () => time });
    const expected = path.join(backups, `serverdesk-pre-0001_safe_probe-${stamp}.dump`);
    assert.deepEqual(result, { applied: 1, total: 2, backup: expected }, 'the JSON output names the backup');
    assert.deepEqual(dumps.map(dump => dump.file), [expected], 'exactly one backup, before the migration');
    assert.deepEqual([dumps[0].url, dumps[0].password], [database.url, database.password], 'the dump gets the address and the password, not the migration');
    assert.ok((await readFile(expected + '.sha256', 'utf8')).startsWith(createHash('sha256').update(await readFile(expected)).digest('hex') + '  '));
    assert.deepEqual(notices, [`Backup before migration ${pending} created: ${expected}`]);
    assert.deepEqual(await journalNames(database), ['0000_baseline.sql', pending]);
    assert.ok(await exists(database, 'safe_probe'));
  });
});

test('an existing backup is never overwritten', async () => {
  await pendingFixture(async ({ database, migrations, backups }) => {
    const taken = path.join(backups, `serverdesk-pre-0001_safe_probe-${stamp}.dump`);
    await mkdir(backups);
    await writeFile(taken, 'older backup');
    await writeFile(taken + '.sha256', 'older checksum');
    const result = await migrateDatabase(database, { directory: migrations, backup: { url: database.url, directory: backups, dump: fakeDump }, clock: () => time });
    assert.equal(result.backup, path.join(backups, `serverdesk-pre-0001_safe_probe-${stamp}-2.dump`), 'the next free name');
    assert.equal(await readFile(taken, 'utf8'), 'older backup', 'the older file stays');
    assert.equal(await readFile(taken + '.sha256', 'utf8'), 'older checksum');
  });
});

test('a failing pg_dump applies no migration and the message names what to check', async () => {
  await pendingFixture(async ({ database, migrations, backups, directory }) => {
    // PG_BIN_DIR points to a pg_dump that exits 1; on Windows to a directory without pg_dump.
    const bin = path.join(directory, 'bin');
    await mkdir(bin);
    if (process.platform !== 'win32') {
      await writeFile(path.join(bin, 'pg_dump'), '#!/bin/sh\nexit 1\n');
      await chmod(path.join(bin, 'pg_dump'), 0o755);
    }
    await assert.rejects(
      migrateDatabase(database, { directory: migrations, backup: { url: database.url, password: database.password, directory: backups, pgBinDir: bin }, clock: () => time }),
      error => {
        assert.match(error.message, /^The backup before the migration 0001_safe_probe\.sql failed: .+\. No migration was applied\. Check the free space and the write permission in .+, and that pg_dump has the major version of the server \(PG_BIN_DIR\)\.$/);
        assert.ok(!error.message.includes(database.password), 'the password is in no message');
        return true;
      });
    assert.deepEqual(await journalNames(database), ['0000_baseline.sql'], 'nothing is applied');
    assert.equal(await exists(database, 'safe_probe'), false);
    assert.deepEqual(await readdir(backups).catch(() => []), [], 'no dump file is left');
  });
});

test('--skip-backup migrates without a backup and writes the notice', async () => {
  await pendingFixture(async ({ database, migrations, backups }) => {
    const notices = [];
    dumps.length = 0;
    const result = await migrateDatabase(database, { directory: migrations, backup: { url: database.url, directory: backups, skip: true, dump: fakeDump }, notice: message => notices.push(message), clock: () => time });
    assert.deepEqual(result, { applied: 1, total: 2 }, 'no backup in the output');
    assert.deepEqual(dumps, []);
    assert.deepEqual(notices, ['migrate runs without a backup (--skip-backup). Make sure that you have a current backup of the database.']);
    assert.ok(await exists(database, 'safe_probe'));
  });
});

test('no backup for an empty database or without pending migrations', async () => {
  await temporaryDirectory(async backups => {
    dumps.length = 0;
    const database = await testDatabase({ template: false });
    try {
      const options = { backup: { url: database.url, directory: backups, dump: fakeDump }, clock: () => time };
      const count = (await readdir(shipped)).filter(name => /^\d{4}_.+\.sql$/.test(name)).length;
      assert.deepEqual(await migrateDatabase(database, options), { applied: count, total: count }, 'an empty database gets every migration without a backup');
      assert.deepEqual(await migrateDatabase(database, options), { applied: 0, total: count }, 'nothing pending, no backup');
      assert.deepEqual(dumps, []);
      assert.deepEqual(await readdir(backups), []);
    } finally { await database.close(); }
  });
});

// ---- The schema lock ---------------------------------------------------------------

/** Split a schema lock into its objects; a blank line inside an object's SQL stays with it. */
function lockObjects(text) {
  const objects = new Map();
  let current;
  for (const chunk of text.replace(/\n$/, '').split('\n\n').slice(1)) {
    const match = /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:UNIQUE\s+)?(TABLE|INDEX|VIEW|FUNCTION|TRIGGER)\s+(?:public\.)?("(?:[^"]|"")+"|[^\s(]+)/i.exec(chunk);
    if (!match && current) {
      objects.set(current, `${objects.get(current)}\n\n${chunk}`);
      continue;
    }
    const name = match ? match[2].replace(/^"|"$/g, '') : chunk.split('\n', 1)[0];
    current = `${match ? match[1].toLowerCase() : 'unknown'} ${name}`;
    objects.set(current, chunk);
  }
  return objects;
}

function lockDifferences(expected, actual) {
  const before = lockObjects(expected), after = lockObjects(actual);
  const changes = [];
  for (const [key, text] of after) {
    if (!before.has(key)) changes.push(`${key}: added`);
    else if (before.get(key) !== text) changes.push(`${key}: changed`);
  }
  for (const key of before.keys()) if (!after.has(key)) changes.push(`${key}: missing`);
  if (!changes.length && expected !== actual) changes.push('header or format: changed');
  return changes;
}

async function migratedLock() {
  const database = await testDatabase({ template: false });
  try {
    await migrateDatabase(database, { directory: shipped });
    return await schemaLock(database);
  } finally { await database.close(); }
}

test('schema.lock.sql matches a freshly migrated database', async () => {
  const actual = await migratedLock();
  const expected = await readFile(lockFile, 'utf8');
  if (actual !== expected) {
    assert.fail(`drizzle/schema.lock.sql differs from the migrated schema (${lockDifferences(expected, actual).join(', ')}). Run pnpm db:schema-lock and check the change in the diff.`);
  }
  assert.ok(actual.startsWith('-- ServerDesk schema after all migrations. Generated by pnpm db:schema-lock; do not edit by hand.\n\n'));
  assert.ok(actual.endsWith(';\n') && !actual.endsWith('\n\n'));
  assert.ok(!actual.includes('\r'), 'LF only');
  assert.ok(!actual.includes('_serverdesk_migrations'));
  assert.ok(actual.includes('CREATE TABLE "local_users"'));
  assert.ok(actual.includes('CREATE VIEW "device_group_ancestors"'));
  const kinds = [...lockObjects(actual).keys()].map(key => key.split(' ')[0]);
  const order = ['table', 'index', 'view', 'function', 'trigger'];
  assert.deepEqual(kinds, [...kinds].sort((a, b) => order.indexOf(a) - order.indexOf(b)), 'tables, then indexes, views, functions and triggers');
  // 72 triggers of the baseline, 2 cleanup triggers of 0001_alert_rule_overrides.sql,
  // 2 of 0003_device_description_tags.sql, 2 of 0004_health_signals.sql, 1 of 0005_alerts.sql,
  // 1 of 0007_health_signals_2.sql, 2 of 0008_notifications.sql, 1 of 0019_agent_plugins.sql
  // and 1 of 0021_agent_integrity_events.sql; migration 0038 drops
  // 3 of the baseline; 0039_customer_scope_overrides.sql adds 2 and
  // 0040_multiple_customers.sql adds 3; 0041_customer_delete.sql drops 1 and adds 5.
  assert.equal(kinds.filter(kind => kind === 'trigger').length, 90, 'the 90 triggers');
  for (const kind of order) {
    const names = [...lockObjects(actual).keys()].filter(key => key.startsWith(kind + ' ')).map(key => key.slice(kind.length + 1));
    assert.deepEqual(names, [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), `${kind} names are sorted`);
  }
});

test('the lock difference names the first object and how it changed', () => {
  const header = '-- ServerDesk schema after all migrations. Generated by pnpm db:schema-lock; do not edit by hand.';
  const expected = `${header}\n\nCREATE TABLE "a" (\n x text\n);\n\nCREATE TABLE "b" (\n\n y text\n);\n\nCREATE INDEX a_x ON public.a USING btree (x);\n`;
  assert.deepEqual(lockDifferences(expected, expected), []);
  assert.deepEqual(lockDifferences(expected, `${header}\n\nCREATE TABLE "a" (\n x text\n);\n\nCREATE TABLE "b" (\n\n y text, z text\n);\n\nCREATE TABLE "probe" (\n x text\n);\n`), ['table b: changed', 'table probe: added', 'index a_x: missing']);
});

test('schemaLock is deterministic', async () => {
  assert.equal(await migratedLock(), await migratedLock());
});
