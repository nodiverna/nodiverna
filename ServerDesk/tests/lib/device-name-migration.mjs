// The device name source migration (drizzle/0031_device_name_source.sql):
// every existing device is classified once (no snapshot: pending; the stored
// name equals the reported computer name in any case, or can be a Windows
// computer name of 1 to 15 letters, digits or hyphens: hostname; else custom).
// It changes no name and writes no audit row and no previous name. The column,
// its CHECK and the device_previous_names table with its key CHECK, primary
// key and cascade are in place. The migrations before it stay unchanged.
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sql } from '../../runtime/database.mjs';
import { migrateDatabase } from '../../scripts/selfhost.mjs';
import { testDatabase } from '../support/postgres.mjs';

const shipped = fileURLToPath(new URL('../../drizzle/', import.meta.url));
const sourceMigration = '0031_device_name_source.sql';
const firstCustomer = '00000000-0000-4000-8000-000000000100';
const at = Date.UTC(2031, 0, 1);

/** An empty database migrated with the shipped migrations before the name source migration; then it is added to the directory. */
async function beforeNameSource(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'serverdesk-device-name-source-'));
  const database = await testDatabase({ template: false });
  try {
    const files = (await readdir(shipped)).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort();
    assert.ok(files.includes(sourceMigration), `${sourceMigration} is shipped`);
    const earlier = files.filter(name => name < sourceMigration);
    for (const name of earlier) await copyFile(path.join(shipped, name), path.join(directory, name));
    assert.deepEqual(await migrateDatabase(database, { directory }), { applied: earlier.length, total: earlier.length });
    const addSourceMigration = () => copyFile(path.join(shipped, sourceMigration), path.join(directory, sourceMigration));
    return await run({ database, directory, addSourceMigration, total: earlier.length + 1 });
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

const device = (id, name, snapshot) =>
  sql`INSERT INTO servers(id,name,token_hash,created_at,customer_id,snapshot) VALUES(${id},${name},${'token-' + id},${at},${firstCustomer},${snapshot === null ? null : JSON.stringify(snapshot)})`;

test('existing devices are classified once, and no name, audit row or previous name changes', async () => {
  await beforeNameSource(async ({ database, directory, addSourceMigration, total }) => {
    const rows = [
      ['d-never', 'SRV-NEVER', null, 'pending'],
      ['d-never-custom', 'Fileserver Berlin', null, 'pending'],
      ['d-same', 'srv-app01', { hostname: 'SRV-APP01' }, 'hostname'],
      ['d-same-padded', 'Web Server', { hostname: '  web server ' }, 'hostname'],
      ['d-renamed', 'SRV-OLD', { hostname: 'SRV-NEW' }, 'hostname'],
      ['d-no-hostname', 'SRV-QUIET', {}, 'hostname'],
      ['d-custom', 'Fileserver Berlin', { hostname: 'SRV-FS01' }, 'custom'],
      ['d-period', 'srv.lab', { hostname: 'SRV' }, 'custom'],
      ['d-underscore', 'SRV_APP', { hostname: 'SRV' }, 'custom'],
      ['d-long', 'SRV-ABCDEFGHIJKL', { hostname: 'SRV' }, 'custom'],
      ['d-fifteen', 'SRV-ABCDEFGHIJK', { hostname: 'SRV' }, 'hostname'],
    ];
    for (const [id, name, snapshot] of rows) await database.exec(device(id, name, snapshot));
    // A snapshot that is no JSON object (an old or broken row) is not read as one.
    await database.exec(sql`INSERT INTO servers(id,name,token_hash,created_at,customer_id,snapshot) VALUES('d-text','Custom Text','token-text',${at},${firstCustomer},'not json')`);
    rows.push(['d-text', 'Custom Text', 'not json', 'custom']);
    const auditBefore = Number((await database.one(sql`SELECT count(*) AS n FROM audit`)).n);
    await addSourceMigration();
    assert.deepEqual(await migrateDatabase(database, { directory }), { applied: 1, total });
    const stored = await database.query(sql`SELECT id,name,name_source FROM servers ORDER BY id`);
    assert.deepEqual(stored.map(row => [row.id, row.name, row.name_source]), rows.map(([id, name, , source]) => [id, name, source]).sort((a, b) => a[0].localeCompare(b[0])), 'every row is classified and keeps its name');
    assert.equal(Number((await database.one(sql`SELECT count(*) AS n FROM audit`)).n), auditBefore, 'no audit row');
    assert.equal(Number((await database.one(sql`SELECT count(*) AS n FROM device_previous_names`)).n), 0, 'no previous name');

    const column = await database.one(sql`SELECT data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='servers' AND column_name='name_source'`);
    assert.deepEqual({ ...column }, { data_type: 'text', is_nullable: 'NO', column_default: "'hostname'::text" }, 'name_source is text NOT NULL DEFAULT hostname');
    const constraint = async (table, name) => (await database.one(sql`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=${table}::regclass AND conname=${name}`))?.definition;
    assert.equal(await constraint('servers', 'servers_name_source_check'), "CHECK ((name_source = ANY (ARRAY['hostname'::text, 'custom'::text, 'pending'::text])))");
    assert.equal(await constraint('device_previous_names', 'device_previous_names_name_key_check'), "CHECK ((name_key <> ''::text))");
    assert.equal(await constraint('device_previous_names', 'device_previous_names_pkey'), 'PRIMARY KEY (server_id, name_key)');
    assert.equal(await constraint('device_previous_names', 'device_previous_names_server_id_servers_id_fk'), 'FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE');

    await assert.rejects(database.exec(sql`UPDATE servers SET name_source='other' WHERE id='d-same'`), error => error.code === '23514' && error.constraint_name === 'servers_name_source_check', 'an unknown source is refused');
    const previous = (key, name = 'OLD') => database.exec(sql`INSERT INTO device_previous_names(server_id,name,name_key,replaced_at) VALUES('d-renamed',${name},${key},${at})`);
    await assert.rejects(previous(''), error => error.code === '23514' && error.constraint_name === 'device_previous_names_name_key_check', 'an empty key is refused');
    await previous('old');
    await assert.rejects(previous('old', 'Old'), error => error.code === '23505', 'one row per key and device');
    await database.exec(sql`DELETE FROM servers WHERE id='d-renamed'`);
    assert.equal(Number((await database.one(sql`SELECT count(*) AS n FROM device_previous_names`)).n), 0, 'the previous names go with the device row');
    assert.deepEqual(await migrateDatabase(database, { directory }), { applied: 0, total }, 'a second migrate applies nothing');
  });
});
