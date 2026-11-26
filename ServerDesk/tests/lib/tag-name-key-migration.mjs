// The tag name key migration (drizzle/0011_tag_name_key.sql): tags stored
// before it get name_key = lower(name), the column is NOT NULL with a CHECK
// against the empty key, idx_tags_scope_name is unique on (scope_type,
// scope_id, name_key) under its old name and idx_tags_name_value covers
// (name_key, value). The migrations before it stay unchanged; the trigger
// count is pinned in tests/repo/selfhost-safe-migrations.mjs.
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
const keyMigration = '0011_tag_name_key.sql';
const firstCustomer = '00000000-0000-4000-8000-000000000100';
const at = Date.UTC(2031, 0, 1);

/** An empty database migrated with the shipped migrations before the key migration; then it is added to the directory. */
async function beforeNameKey(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'serverdesk-tag-name-key-'));
  const database = await testDatabase({ template: false });
  try {
    const files = (await readdir(shipped)).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort();
    assert.ok(files.includes(keyMigration), `${keyMigration} is shipped`);
    const earlier = files.filter(name => name < keyMigration);
    for (const name of earlier) await copyFile(path.join(shipped, name), path.join(directory, name));
    assert.deepEqual(await migrateDatabase(database, { directory }), { applied: earlier.length, total: earlier.length });
    const addKeyMigration = () => copyFile(path.join(shipped, keyMigration), path.join(directory, keyMigration));
    return await run({ database, directory, addKeyMigration, total: earlier.length + 1 });
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

const tag = (id, scopeType, scopeId, name, value = '', inherit = 0) =>
  sql`INSERT INTO tags(id,scope_type,scope_id,name,value,inherit,created_at,updated_at,updated_by) VALUES(${id},${scopeType},${scopeId},${name},${value},${inherit},${at},${at},'fixture')`;

test('tags stored before the migration get name_key = lower(name), and the column, CHECK and indexes are in place', async () => {
  await beforeNameKey(async ({ database, directory, addKeyMigration, total }) => {
    await database.exec(sql`INSERT INTO servers(id,name,token_hash,created_at,customer_id) VALUES('device-1','Gerät 1','token-1',${at},${firstCustomer})`);
    await database.exec(sql`INSERT INTO device_groups(id,name,description,created_at,parent_id,customer_id) VALUES('group-1','Gruppe 1','',${at},NULL,${firstCustomer})`);
    await database.exec(tag('t-1', 'device', 'device-1', 'Umgebung', 'Prod'));
    await database.exec(tag('t-2', 'device', 'device-1', 'SITE', 'HQ'));
    await database.exec(tag('t-3', 'group', 'group-1', 'Owner', 'Team', 1));
    await database.exec(tag('t-4', 'group', 'group-1', 'Größe', ''));
    await addKeyMigration();
    assert.deepEqual(await migrateDatabase(database, { directory }), { applied: 1, total });
    const rows = await database.query(sql`SELECT id,name,name_key,name_key=lower(name) AS lowered FROM tags ORDER BY id`);
    assert.deepEqual(rows.map(row => [row.id, row.name, row.name_key, row.lowered]), [
      ['t-1', 'Umgebung', 'umgebung', true], ['t-2', 'SITE', 'site', true], ['t-3', 'Owner', 'owner', true], ['t-4', 'Größe', 'größe', true],
    ], 'every existing row gets lower(name)');
    for (const row of rows) assert.equal(row.name_key, row.name.toLowerCase(), `${row.name}: for these letters lower() equals tagKey`);

    const column = await database.one(sql`SELECT data_type,is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='tags' AND column_name='name_key'`);
    assert.deepEqual(column, { data_type: 'text', is_nullable: 'NO' }, 'name_key is text NOT NULL');
    const check = await database.one(sql`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='tags'::regclass AND conname='tags_name_key_check'`);
    assert.equal(check.definition, "CHECK ((name_key <> ''::text))");
    const indexes = Object.fromEntries((await database.query(sql`SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='tags' AND indexname LIKE 'idx_tags_%'`)).map(row => [row.indexname, row.indexdef]));
    assert.deepEqual(indexes, {
      idx_tags_scope_name: 'CREATE UNIQUE INDEX idx_tags_scope_name ON public.tags USING btree (scope_type, scope_id, name_key)',
      idx_tags_name_value: 'CREATE INDEX idx_tags_name_value ON public.tags USING btree (name_key, value)',
    });

    const insert = nameKey => database.exec(sql`INSERT INTO tags(id,scope_type,scope_id,name,name_key,value,inherit,created_at,updated_at,updated_by) VALUES(${'t-' + String(nameKey)},'device','device-1','New',${nameKey},'',0,${at},${at},'fixture')`);
    await assert.rejects(database.exec(tag('t-5', 'device', 'device-1', 'Without key')), error => error.code === '23502', 'a row without name_key is refused');
    await assert.rejects(insert(''), error => error.code === '23514' && error.constraint_name === 'tags_name_key_check', 'an empty key is refused');
    await assert.rejects(insert('umgebung'), error => error.code === '23505' && error.constraint_name === 'idx_tags_scope_name', 'the key is unique per object');
    await insert('new');
    assert.deepEqual(await migrateDatabase(database, { directory }), { applied: 0, total }, 'a second migrate applies nothing');
  });
});
