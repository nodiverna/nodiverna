// The data migration *_release_catalog_files.sql: agent_releases rows without
// file rows (built-in releases of earlier images, record-only imports) go with
// their states; pending updates for a release that is gone are cancelled,
// running ones stay; imported releases and their jobs do not change.
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sql } from '../../runtime/database.mjs';
import { migrateDatabase } from '../../scripts/selfhost.mjs';
import { testDatabase } from '../support/postgres.mjs';

const shipped = fileURLToPath(new URL('../../drizzle/', import.meta.url));
const migration = (await readdir(shipped)).find(name => /^\d{4}_release_catalog_files\.sql$/.test(name));
const sha = character => character.repeat(64);

/** A database migrated with the shipped migrations before this one; addMigration copies it in. */
async function beforeMigration(run) {
  assert.ok(migration, 'the migration exists');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'serverdesk-release-catalog-'));
  const database = await testDatabase({ template: false });
  try {
    const earlier = (await readdir(shipped)).filter(name => /^\d{4}_.+\.sql$/.test(name) && name < migration).sort();
    for (const name of earlier) await copyFile(path.join(shipped, name), path.join(directory, name));
    await migrateDatabase(database, { directory });
    return await run({ database, directory, addMigration: () => copyFile(path.join(shipped, migration), path.join(directory, migration)), total: earlier.length + 1 });
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function seed(database) {
  const time = Date.UTC(2026, 9, 1), server = '10000000-0000-4000-8000-0000000000aa';
  const legacy = '10000000-0000-4000-8000-000000000001', imported = '10000000-0000-4000-8000-000000000002', recordOnly = '10000000-0000-4000-8000-000000000003';
  await database.exec(sql`INSERT INTO servers(id,name,token_hash,created_at,management) VALUES(${server},'HOST','fixture',${time},1)`);
  const release = (id, version) => database.exec(sql`INSERT INTO agent_releases(id,version,manifest,signature,sha256,size,created_at) VALUES(${id},${version},'{}','c2ln',${sha('a')},5,${time})`);
  await release(legacy, '4.7.3');
  await release(imported, '4.13.0');
  await release(recordOnly, '4.7.2');
  await database.exec(sql`INSERT INTO agent_release_files(release_id,path,size,sha256,chunks) VALUES(${imported},'/downloads/ServerDesk-Agent-4.13.0-win-x64.zip',5,${sha('a')},${JSON.stringify([{ sha256: sha('a'), size: 5 }])})`);
  await database.exec(sql`INSERT INTO agent_release_states(release_id,state,updated_at,updated_by) VALUES(${legacy},'disabled',${time},'owner'),(${imported},'disabled',${time},'owner')`);
  const job = (id, releaseId, state) => database.exec(sql`INSERT INTO jobs(id,server_id,action,target,parameters,state,created_at,actor,actor_email) VALUES(${id},${server},'agent-update','4.7.3',${JSON.stringify({ releaseId, manifest: '{}', signature: 'c2ln' })},${state},${time},'owner','owner@example.test')`);
  await job('job-legacy-pending', legacy, 'pending');
  await job('job-legacy-running', legacy, 'running');
  await job('job-imported-pending', imported, 'pending');
  await database.exec(sql`INSERT INTO agent_release_imports(tag,source,version,status,reason,release_id,fingerprint,attempted_at) VALUES
    ('agent-v4.13.0','github','4.13.0','imported',NULL,${imported},'f1',${time}),
    ('agent-v4.7.2','folder','4.7.2','present',NULL,${recordOnly},NULL,${time}),
    ('agent-v4.7.3','github','4.7.3','failed','versionConflict',NULL,'f2',${time}),
    ('agent-v4.13.1','github','4.13.0','failed','versionConflict',NULL,'f3',${time})`);
  return { legacy, imported, recordOnly };
}

const snapshot = async database => ({
  releases: await database.query(sql`SELECT id,version FROM agent_releases ORDER BY id`),
  states: await database.query(sql`SELECT release_id,state FROM agent_release_states ORDER BY release_id`),
  jobs: await database.query(sql`SELECT id,state,parameters,result FROM jobs ORDER BY id`),
  imports: await database.query(sql`SELECT tag,status FROM agent_release_imports ORDER BY tag`),
});

test('the migration removes file-less releases and their states, cancels only their pending updates and applies once', () => beforeMigration(async ({ database, directory, addMigration, total }) => {
  const { imported } = await seed(database);
  const runningBefore = await database.one(sql`SELECT parameters FROM jobs WHERE id='job-legacy-running'`);
  await addMigration();
  assert.deepEqual(await migrateDatabase(database, { directory }), { applied: 1, total });
  const after = await snapshot(database);
  assert.deepEqual(after.releases, [{ id: imported, version: '4.13.0' }], 'only the release with file rows stays');
  assert.deepEqual(after.states, [{ release_id: imported, state: 'disabled' }], 'the state of the removed release goes');
  assert.deepEqual(after.jobs, [
    { id: 'job-imported-pending', state: 'pending', parameters: JSON.stringify({ releaseId: imported, manifest: '{}', signature: 'c2ln' }), result: null },
    { id: 'job-legacy-pending', state: 'cancelled', parameters: '{}', result: 'serverMessage.release.disabled' },
    { id: 'job-legacy-running', state: 'running', parameters: runningBefore.parameters, result: null },
  ], 'the pending update of the removed release is cancelled; the running one keeps its envelope');
  assert.deepEqual(after.imports, [{ tag: 'agent-v4.13.0', status: 'imported' }, { tag: 'agent-v4.13.1', status: 'failed' }], 'import rows of the removed release and conflicts with its gone version are forgotten');
  assert.deepEqual(await migrateDatabase(database, { directory }), { applied: 0, total }, 'a second migrate applies nothing');
}));

test('on a database with only imported releases the migration changes nothing', () => beforeMigration(async ({ database, directory, addMigration }) => {
  const { legacy, recordOnly } = await seed(database);
  // Remove the legacy fixture first: only imported releases remain.
  await database.exec(sql`DELETE FROM jobs WHERE id IN ('job-legacy-pending','job-legacy-running')`);
  await database.exec(sql`DELETE FROM agent_release_states WHERE release_id=${legacy}`);
  await database.exec(sql`DELETE FROM agent_release_imports WHERE tag IN ('agent-v4.7.2','agent-v4.7.3')`);
  await database.exec(sql`DELETE FROM agent_releases WHERE id IN (${legacy},${recordOnly})`);
  const before = await snapshot(database);
  await addMigration();
  await migrateDatabase(database, { directory });
  assert.deepEqual(await snapshot(database), before);
}));

test('the migration is data only: no schema statement', async () => {
  const text = await readFile(path.join(shipped, migration), 'utf8');
  assert.doesNotMatch(text, /\b(?:CREATE|ALTER|DROP)\b/i);
});
