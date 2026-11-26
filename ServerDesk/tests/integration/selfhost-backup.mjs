// selfhost.mjs backup and restore with the real pg_dump and pg_restore: a dump
// of a migrated database with rows restores into an empty database with the
// same row count in every table and the same journal; a database with tables
// is refused without --replace; a dump whose .sha256 does not match is refused;
// the password appears in no output. The commands need pg_dump/pg_restore of
// major version 17 (PG_BIN_DIR or PATH). Without them this file prints a SKIP
// line and passes; pnpm pipeline smoke runs the same round trip in the image.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDatabase, sql } from '../../runtime/database.mjs';
import { migrateDatabase } from '../../scripts/selfhost.mjs';
import { createTestDatabase } from '../support/postgres.mjs';
import { serverDeskRoot } from '../support/paths.mjs';

const projectRoot = serverDeskRoot;
const tool = name => (process.env.PG_BIN_DIR ? path.join(process.env.PG_BIN_DIR, process.platform === 'win32' ? `${name}.exe` : name) : name);
const major = name => {
  const run = spawnSync(tool(name), ['--version'], { encoding: 'utf8', windowsHide: true });
  return run.status === 0 ? Number(/\(PostgreSQL\)\s+(\d+)/.exec(run.stdout)?.[1]) : null;
};
if (major('pg_dump') !== 17 || major('pg_restore') !== 17) {
  console.log('SKIP: pg_dump 17 not found');
  process.exit(0);
}

const directory = await mkdtemp(path.join(os.tmpdir(), 'serverdesk-backup-'));
const source = await createTestDatabase({ template: false }), target = await createTestDatabase({ template: false });
const environment = address => ({ ...process.env, DATABASE_URL: address.url, DATABASE_PASSWORD: address.password, BACKUP_DIRECTORY: path.join(directory, 'backups') });
const cli = (address, args) => spawnSync(process.execPath, ['scripts/selfhost.mjs', ...args], { cwd: projectRoot, env: environment(address), encoding: 'utf8', timeout: 120_000 });
const pool = address => createDatabase({ url: address.url, password: address.password, max: 2 });
// Row count per table in public, and the journal.
async function state(address) {
  const database = pool(address);
  try {
    const tables = (await database.query(sql`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`)).map(row => row.tablename);
    const counts = {};
    for (const table of tables) counts[table] = (await database.one(sql`SELECT count(*) AS n FROM ${sql.ident(table)}`)).n;
    const journal = tables.includes('_serverdesk_migrations') ? await database.query(sql`SELECT name,checksum,applied_at FROM _serverdesk_migrations ORDER BY name`) : [];
    return { counts, journal };
  } finally { await database.close(); }
}
const secretFree = (run, label) => {
  const output = run.stdout + run.stderr;
  assert.equal(output.includes(source.password), false, `${label}: the password is in no output`);
};

try {
  // A migrated source with rows in several tables.
  const database = pool(source);
  try {
    await migrateDatabase(database);
    const at = Date.now();
    await database.exec(sql`INSERT INTO servers(id,name,token_hash,created_at) VALUES(${randomUUID()},'Backup device','token',${at})`);
    await database.exec(sql`INSERT INTO audit(at,actor,action,target) VALUES(${at},'tester','backup.test','row')`);
    await database.exec(sql`INSERT INTO device_groups(id,name,created_at) VALUES(${randomUUID()},'Backup group',${at})`);
  } finally { await database.close(); }
  const before = await state(source);

  const file = path.join(directory, 'manual.dump');
  const backup = cli(source, ['backup', '--output', file]);
  assert.equal(backup.status, 0, backup.stderr);
  secretFree(backup, 'backup');
  const written = JSON.parse(backup.stdout);
  assert.equal(written.file, file);
  assert.match(written.sha256, /^[0-9a-f]{64}$/);
  assert.ok(written.bytes > 0);
  assert.ok((await readFile(file + '.sha256', 'utf8')).startsWith(written.sha256 + '  '), 'the .sha256 file names the digest');
  // The dump holds password hashes and encrypted secrets: owner-only modes (POSIX only).
  if (process.platform !== 'win32') {
    const nested = path.join(directory, 'private', 'nested.dump');
    const created = cli(source, ['backup', '--output', nested]);
    assert.equal(created.status, 0, created.stderr);
    assert.equal((await stat(path.dirname(nested))).mode & 0o777, 0o700, 'a new backup directory is owner-only');
    for (const name of [nested, nested + '.sha256']) assert.equal((await stat(name)).mode & 0o777, 0o600, `${name} is owner-only`);
  }
  const again = cli(source, ['backup', '--output', file]);
  assert.equal(again.status, 1, 'an existing dump file is never overwritten');

  const restored = cli(target, ['restore', '--input', file]);
  assert.equal(restored.status, 0, restored.stderr);
  secretFree(restored, 'restore');
  const result = JSON.parse(restored.stdout);
  assert.deepEqual(result.pending, [], 'every shipped migration is applied');
  assert.deepEqual(result.applied, before.journal.map(row => row.name));
  assert.deepEqual(await state(target), before, 'the same row count in every table and the same journal');

  const refused = cli(target, ['restore', '--input', file]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /The database already contains tables\. Restore into an empty database, or add --replace to replace its contents/);
  const replaced = cli(target, ['restore', '--input', file, '--replace']);
  assert.equal(replaced.status, 0, replaced.stderr);
  assert.deepEqual(await state(target), before, '--replace restores the same contents');

  await writeFile(file + '.sha256', `${'0'.repeat(64)}  manual.dump\n`);
  const mismatch = cli(target, ['restore', '--input', file, '--replace']);
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stderr, /does not match its checksum file\. The dump was not restored/);
  for (const run of [again, refused, replaced, mismatch]) secretFree(run, 'every command');
  console.log('PASS backup and restore: round trip with equal row counts and journal, no overwrite, refusal of a database with tables and of a checksum mismatch, no password in any output.');
} finally {
  await source.drop();
  await target.drop();
  await rm(directory, { recursive: true, force: true });
}
