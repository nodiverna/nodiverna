// The agent plugins migrations (drizzle/*_agent_plugins.sql, *_dhcp_service.sql): import rows stored
// before it get kind = 'agent', the stored built-in roles Reader, Operator and
// Device Administrator get the server role rights once, custom and changed
// Owner rows stay, a removed device keeps no plugin data, and a second
// migrate applies nothing. The trigger count is pinned in
// tests/repo/selfhost-safe-migrations.mjs.
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sql } from '../../runtime/database.mjs';
import { migrateDatabase } from '../../scripts/selfhost.mjs';
import { testDatabase } from '../support/postgres.mjs';
import { sourceLoader } from '../support/source-database.mjs';

const shipped = fileURLToPath(new URL('../../drizzle/', import.meta.url));
const at = Date.UTC(2031, 0, 1);

async function beforePlugins(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'serverdesk-agent-plugins-'));
  const database = await testDatabase({ template: false });
  try {
    const files = (await readdir(shipped)).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort();
    const migration = files.find(name => name.endsWith('_agent_plugins.sql'));
    assert.ok(migration, 'the agent plugins migration is shipped');
    const earlier = files.filter(name => name < migration);
    for (const name of earlier) await copyFile(path.join(shipped, name), path.join(directory, name));
    assert.deepEqual(await migrateDatabase(database, { directory }), { applied: earlier.length, total: earlier.length });
    const add = () => copyFile(path.join(shipped, migration), path.join(directory, migration));
    return await run({ database, directory, add, total: earlier.length + 1 });
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

const role = (id, permissions, builtin = 1) =>
  sql`INSERT INTO rbac_roles(id,name,description,permissions,builtin,created_at) VALUES(${id},${id},'',${JSON.stringify(permissions)},${builtin},${at})`;

test('the migration adds the server role rights to the stored built-in roles once and keeps everything else', async () => {
  await beforePlugins(async ({ database, directory, add, total }) => {
    await database.exec(role('builtin-reader', ['view', 'diagnose']));
    await database.exec(role('builtin-operator', ['view', 'jobs.run', 'dhcp.read']));
    await database.exec(role('builtin-device-administrator', ['view']));
    await database.exec(role('builtin-owner', ['*']));
    await database.exec(role('custom-role', ['view']));
    await database.exec(role('builtin-user-access-administrator', ['portal.users.manage']));
    await database.exec(sql`INSERT INTO agent_release_imports(tag,source,version,status,attempted_at) VALUES('v4.13.0','github','4.13.0','imported',${at})`);
    await add();
    assert.deepEqual(await migrateDatabase(database, { directory }), { applied: 1, total });
    const stored = Object.fromEntries((await database.query(sql`SELECT id,permissions FROM rbac_roles`)).map(row => [row.id, JSON.parse(row.permissions)]));
    assert.deepEqual(stored, {
      'builtin-reader': ['view', 'diagnose', 'dhcp.read', 'dns.read'],
      'builtin-operator': ['view', 'jobs.run', 'dhcp.read', 'plugins.manage', 'dhcp.manage', 'dns.read', 'dns.manage'],
      'builtin-device-administrator': ['view', 'plugins.manage', 'dhcp.read', 'dhcp.manage', 'dns.read', 'dns.manage'],
      'builtin-owner': ['*'],
      'custom-role': ['view'],
      'builtin-user-access-administrator': ['portal.users.manage'],
    }, 'Reader reads DHCP and DNS, Operator and Device Administrator get all five once, the others stay');
    const column = await database.one(sql`SELECT column_default,is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='agent_release_imports' AND column_name='kind'`);
    assert.deepEqual(column, { column_default: "'agent'::text", is_nullable: 'NO' }, 'kind is NOT NULL with the default agent');
    assert.deepEqual(await database.query(sql`SELECT tag,kind FROM agent_release_imports`), [{ tag: 'v4.13.0', kind: 'agent' }], 'an import row of before is an agent import');

    // A removed device keeps no plugin data.
    await database.exec(sql`INSERT INTO servers(id,name,token_hash,created_at) VALUES('device-1','DC1','token-1',${at})`);
    await database.exec(sql`INSERT INTO device_plugin_data(server_id,plugin,operation,data,summary,collected_at,received_at) VALUES('device-1','dhcp','dhcp-read','{}','[]',${at},${at})`);
    await assert.rejects(database.exec(sql`INSERT INTO device_plugin_data(server_id,plugin,operation,data,summary,collected_at,received_at) VALUES('device-1','dns','dns-read','[]','[]',${at},${at})`), error => error.code === '23514', 'data must be a JSON object');
    await database.exec(sql`UPDATE servers SET revoked=1 WHERE id='device-1'`);
    assert.deepEqual(await database.query(sql`SELECT plugin FROM device_plugin_data`), [], 'the trigger deletes the plugin data of a removed device');

    assert.deepEqual(await migrateDatabase(database, { directory }), { applied: 0, total }, 'a second migrate applies nothing');
  });
});

test('built-in rows seeded by the release before the migration end with the lists of a fresh seed', async () => {
  const server = { db: () => null, now: () => at, config: () => '', HttpError: Error };
  const fresh = sourceLoader()('lib/server/identity/rbac.ts', { '../context': server,'./context':server, '@/lib/server/context': server }).builtinRoles();
  const later = ['plugins.manage', 'dhcp.read', 'dhcp.manage', 'dns.read', 'dns.manage'];
  await beforePlugins(async ({ database, directory, add, total }) => {
    // The release before stored every right of a fresh seed except the server role rights.
    for (const role of fresh) await database.exec(sql`INSERT INTO rbac_roles(id,name,description,permissions,builtin,created_at) VALUES(${role.id},${role.name},${role.description},${JSON.stringify(role.permissions.filter(right => !later.includes(right)))},1,${at})`);
    await add();
    assert.deepEqual(await migrateDatabase(database, { directory }), { applied: 1, total });
    const stored = Object.fromEntries((await database.query(sql`SELECT id,permissions FROM rbac_roles`)).map(row => [row.id, row.permissions]));
    assert.deepEqual(stored, Object.fromEntries(fresh.map(role => [role.id, JSON.stringify(role.permissions)])), 'the same stored JSON as a fresh seed, in the same order');
  });
});

test('the DHCP service migration adds device_plugin_data.service and fills it from the stored DHCP reads', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'serverdesk-dhcp-service-'));
  const database = await testDatabase({ template: false });
  try {
    const files = (await readdir(shipped)).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort();
    const migration = files.find(name => name.endsWith('_dhcp_service.sql'));
    assert.ok(migration, 'the DHCP service migration is shipped');
    const earlier = files.filter(name => name < migration);
    for (const name of earlier) await copyFile(path.join(shipped, name), path.join(directory, name));
    await migrateDatabase(database, { directory });
    for (const [id, service] of [['dc-running', 'running'], ['dc-stopped', 'stopped'], ['dc-odd', 'paused']]) {
      await database.exec(sql`INSERT INTO servers(id,name,token_hash,created_at) VALUES(${id},${id},${'token-' + id},${at})`);
      await database.exec(sql`INSERT INTO device_plugin_data(server_id,plugin,operation,data,summary,collected_at,received_at) VALUES(${id},'dhcp','dhcp-read',${JSON.stringify({ schema: 1, service })},'[]',${at},${at})`);
    }
    await database.exec(sql`INSERT INTO device_plugin_data(server_id,plugin,operation,data,summary,collected_at,received_at) VALUES('dc-running','dns','dns-read','{"service":"running"}','[]',${at},${at})`);
    await copyFile(path.join(shipped, migration), path.join(directory, migration));
    assert.deepEqual(await migrateDatabase(database, { directory }), { applied: 1, total: earlier.length + 1 });
    const rows = await database.query(sql`SELECT server_id,plugin,service FROM device_plugin_data ORDER BY server_id,plugin`);
    assert.deepEqual(rows.map(row => [row.server_id, row.plugin, row.service]), [['dc-odd', 'dhcp', null], ['dc-running', 'dhcp', 'running'], ['dc-running', 'dns', null], ['dc-stopped', 'dhcp', 'stopped']], 'the DHCP rows get the service of their read; other rows and unknown states stay NULL');
    await assert.rejects(database.exec(sql`UPDATE device_plugin_data SET service='paused' WHERE server_id='dc-odd'`), error => error.code === '23514', 'only running or stopped');
    assert.deepEqual(await migrateDatabase(database, { directory }), { applied: 0, total: earlier.length + 1 }, 'a second migrate applies nothing');
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
