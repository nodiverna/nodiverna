// The release source token migration (drizzle/0035_release_source_drop_token.sql):
// the portal reads the public repository nodiverna/nodiverna without sign-in, so
// the migration drops agent_release_source.token, token_set_at, token_set_by and
// the CHECK agent_release_source_token_check. A source left at the failure
// "token rejected" gets last_error and last_status NULL and a new requested_at
// (the next scheduler tick checks again); the failed import rows with the reason
// tokenRejected are deleted and no other import row changes. A source without
// that failure keeps its state. The migrations before it stay unchanged.
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sql } from '../../runtime/database.mjs';
import { createKeyring, encryptWithKeyring } from '../../runtime/secret-keyring.mjs';
import { migrateDatabase } from '../../scripts/selfhost.mjs';
import { testDatabase } from '../support/postgres.mjs';

const shipped = fileURLToPath(new URL('../../drizzle/', import.meta.url));
const tokenMigration = '0035_release_source_drop_token.sql';
const at = Date.UTC(2026, 10, 1);
const tokenColumns = ['token', 'token_set_at', 'token_set_by'];

/** An empty database migrated with the shipped migrations before the token migration; then it is added to the directory. */
async function beforeTokenDrop(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'serverdesk-release-token-'));
  const database = await testDatabase({ template: false });
  try {
    const files = (await readdir(shipped)).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort();
    assert.ok(files.includes(tokenMigration), `${tokenMigration} is shipped`);
    const earlier = files.filter(name => name < tokenMigration);
    for (const name of earlier) await copyFile(path.join(shipped, name), path.join(directory, name));
    assert.deepEqual(await migrateDatabase(database, { directory }), { applied: earlier.length, total: earlier.length });
    // The single source row as the earlier migrations leave it.
    await database.exec(sql`INSERT INTO agent_release_source(id) VALUES(1) ON CONFLICT (id) DO NOTHING`);
    const addTokenMigration = () => copyFile(path.join(shipped, tokenMigration), path.join(directory, tokenMigration));
    return await run({ database, directory, addTokenMigration, total: earlier.length + 1 });
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

const importRow = (tag, status, reason) =>
  sql`INSERT INTO agent_release_imports(tag,source,version,status,reason,release_id,fingerprint,attempted_at,kind) VALUES(${tag},'github',${tag.replace(/^agent-v/, '')},${status},${reason},NULL,${'fp-' + tag},${at},'agent')`;
const sourceState = database => database.one(sql`SELECT requested_at,last_started_at,last_finished_at,last_status,last_error FROM agent_release_source WHERE id=1`);
const imports = async database => (await database.query(sql`SELECT tag,status,reason FROM agent_release_imports ORDER BY tag`)).map(row => [row.tag, row.status, row.reason]);
const columns = async database => (await database.query(sql`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='agent_release_source' ORDER BY column_name`)).map(row => row.column_name);
const constraints = async database => (await database.query(sql`SELECT conname FROM pg_constraint WHERE conrelid='agent_release_source'::regclass ORDER BY conname`)).map(row => row.conname);

test('the token columns and their CHECK go; a "token rejected" source asks for a new check; only the tokenRejected import rows are deleted', async () => {
  await beforeTokenDrop(async ({ database, directory, addTokenMigration, total }) => {
    const ciphertext = await encryptWithKeyring(createKeyring({ SESSION_SECRET: 'session-secret-for-release-token-migration-01' }), 'github_pat_' + 'Q7w8'.repeat(8), 'agent-release-github-token');
    await database.exec(sql`UPDATE agent_release_source SET token=${ciphertext},token_set_at=${at},token_set_by='owner@example.test',last_started_at=${at},last_finished_at=${at + 1},last_status='failed',last_error='serverMessage.releaseImport.tokenRejected' WHERE id=1`);
    await database.exec(importRow('agent-v4.12.1', 'failed', 'tokenRejected'));
    await database.exec(importRow('agent-v4.12.0', 'failed', 'signatureInvalid'));
    await database.exec(importRow('agent-v4.11.0', 'imported', null));
    const before = await columns(database);
    assert.ok(tokenColumns.every(name => before.includes(name)), 'the earlier migrations have the token columns');
    assert.ok((await constraints(database)).includes('agent_release_source_token_check'));

    await addTokenMigration();
    const started = Date.now();
    assert.deepEqual(await migrateDatabase(database, { directory }), { applied: 1, total });
    const finished = Date.now();

    const after = await columns(database);
    assert.deepEqual(after.filter(name => tokenColumns.includes(name)), [], 'the three token columns are gone');
    assert.deepEqual(after, before.filter(name => !tokenColumns.includes(name)), 'every other column stays');
    assert.deepEqual(await constraints(database), ['agent_release_source_pkey', 'agent_release_source_single_row', 'agent_release_source_status_check'], 'the token CHECK is gone');
    const state = await sourceState(database);
    assert.deepEqual([state.last_status, state.last_error, Number(state.last_started_at), Number(state.last_finished_at)], [null, null, at, at + 1], 'the failure is cleared; the start and finish stay');
    assert.ok(Number(state.requested_at) >= started - 1000 && Number(state.requested_at) <= finished + 1000, `requested_at is the migration time (${state.requested_at})`);
    assert.ok(Number(state.requested_at) > Number(state.last_started_at), 'the request is newer than the last start: the next tick checks');
    assert.deepEqual(await imports(database), [['agent-v4.11.0', 'imported', null], ['agent-v4.12.0', 'failed', 'signatureInvalid']], 'only the tokenRejected import row is deleted');
    const text = JSON.stringify([await database.query(sql`SELECT * FROM agent_release_source`), await database.query(sql`SELECT * FROM agent_release_imports`)]);
    assert.equal(/tokenRejected|k1\./.test(text), false, 'no row value refers to the release token');
  });
});

test('a source without a stored token or a token failure keeps its state', async () => {
  await beforeTokenDrop(async ({ database, directory, addTokenMigration, total }) => {
    await database.exec(sql`UPDATE agent_release_source SET requested_at=${at - 5},last_started_at=${at},last_finished_at=${at + 1},last_status='failed',last_error='serverMessage.releaseImport.notFound' WHERE id=1`);
    await database.exec(importRow('agent-v4.12.0', 'failed', 'rateLimited'));
    const before = await sourceState(database);
    await addTokenMigration();
    assert.deepEqual(await migrateDatabase(database, { directory }), { applied: 1, total });
    assert.deepEqual(await sourceState(database), before, 'last_status, last_error and requested_at do not change');
    assert.deepEqual(await imports(database), [['agent-v4.12.0', 'failed', 'rateLimited']]);
  });
});
