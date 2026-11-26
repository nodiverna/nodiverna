// The PostgreSQL migration runner (scripts/selfhost.mjs migrate) and the
// baseline migration: one journal row per migration with its LF checksum, the
// refusals with their messages, one application under concurrent runs, the
// seed rows, every trigger of the classification with its literal or writes,
// the settings CHECK at its bounds, the named constraints, a schema that
// drizzle-kit regenerates without change, the offline Owner bootstrap, and
// migration 0038 that drops the license table with its triggers and functions
// and keeps every customer row, and the migration of the setting "Multiple
// customers" (customer_settings): its start value, its three triggers, a
// concurrent create and switch-off, and every other row unchanged; and the
// migration of the customer delete (0041_customer_delete.sql): its tombstone
// table and triggers, history that keeps the customer id, the refusals while
// live data holds the customer, the cascades, a delete racing a device insert,
// and every existing row unchanged; and the branding images (branding_assets): its
// CHECK constraints and the one row per owner and slot; and the branding backgrounds
// (0043): the background slots, branding_settings and account_preferences; and the
// pinned devices (0044): account_pinned_devices with its key, its foreign keys
// and their cascades; and the Dashboard layouts (0045): the column
// account_preferences.dashboard_layout and the one-row table dashboard_settings; and the
// Dashboard widgets (0046): stored layouts of the first Dashboard rewritten to the widget form; and the
// measurement of the console background (0047): the four measure columns of branding_assets and their CHECKs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sql } from '../../runtime/database.mjs';
import { bootstrapOwner, migrateDatabase } from '../../scripts/selfhost.mjs';
import { testDatabase } from '../support/postgres.mjs';
import { serverDeskRoot } from '../support/paths.mjs';

const root = serverDeskRoot;
const directory = fileURLToPath(new URL('../../drizzle/', import.meta.url));
const environment = {
  SITE_ORIGIN: 'https://serverdesk.test',
  SESSION_SECRET: 'isolated-selfhost-session-secret-with-at-least-32-bytes',
  PASSWORD_PEPPER: 'isolated-selfhost-password-pepper-with-at-least-32-bytes',
};
const ownerOptions = { username: 'admin', displayName: 'Administrator', email: 'admin@example.com', env: environment };
const firstCustomer = '00000000-0000-4000-8000-000000000100';
const changedMessage = name => ({ message: `The applied migration ${name} was changed. The database stays unchanged. Create a new migration instead.` });
const noJournalMessage = 'This database contains a schema without a complete ServerDesk migration journal. Nothing is adopted or overwritten automatically. Check the database import first.';

// A database without schema, and a copy of the migrated template.
async function emptyDatabase(run) {
  const database = await testDatabase({ template: false });
  try { return await run(database); } finally { await database.close(); }
}
async function migratedDatabase(run) {
  const database = await testDatabase();
  try { return await run(database); } finally { await database.close(); }
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const lf = bytes => Buffer.from(bytes.toString('latin1').replaceAll('\r\n', '\n'), 'latin1');
const crlf = bytes => Buffer.from(lf(bytes).toString('latin1').replaceAll('\n', '\r\n'), 'latin1');
const journal = async database => database.query(sql`SELECT name,checksum,applied_at FROM _serverdesk_migrations ORDER BY name`);
const exists = async (database, name) => (await database.one(sql`SELECT to_regclass(${'public.' + name}) IS NOT NULL AS found`)).found;
const migrationNames = async () => (await readdir(directory)).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort();

async function migrationFixture(files, run) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'serverdesk-migrations-'));
  try {
    await Promise.all(Object.entries(files).map(([name, source]) => writeFile(path.join(temporary, name), source)));
    return await emptyDatabase(database => run(database, temporary));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

test('the migrations apply once to an empty database and keep their exact LF checksums', async () => {
  await emptyDatabase(async database => {
    const names = await migrationNames();
    assert.equal(names[0], '0000_baseline.sql', 'the PostgreSQL baseline comes first');
    assert.deepEqual(await migrateDatabase(database), { applied: names.length, total: names.length });
    assert.deepEqual(await migrateDatabase(database), { applied: 0, total: names.length }, 'a second run applies nothing');
    const rows = await journal(database);
    assert.deepEqual(rows.map(entry => entry.name), names);
    assert.equal(rows[0].checksum, sha256(lf(await readFile(path.join(directory, names[0])))));
    assert.equal(await database.one(sql`SELECT id FROM local_users LIMIT 1`), null, 'schema creation does not silently create users');
  });
});

test('two parallel runs apply the migrations exactly once', async () => {
  await emptyDatabase(async database => {
    const count = (await migrationNames()).length;
    const results = await Promise.all([migrateDatabase(database), migrateDatabase(database)]);
    // migrateDatabase locks each migration in its own transaction, so the two
    // runs may share the work (37 and 1 on a slow CI runner); each migration
    // is still applied by exactly one of them.
    assert.equal(results[0].applied + results[1].applied, count, `together the runs apply each migration once: ${results.map(result => result.applied).join(' + ')}`);
    assert.ok(results.every(result => result.total === count), 'both runs see every migration');
    assert.deepEqual((await journal(database)).map(entry => entry.name), await migrationNames(), 'the journal lists each migration once');
    assert.deepEqual(await migrateDatabase(database), { applied: 0, total: count }, 'a later run finds them applied');
    assert.equal((await database.one(sql`SELECT count(*) AS n FROM customers`)).n, 1, 'the seed rows exist once');
  });
});

test('readiness journal lists exactly the shipped SQL migrations', async () => {
  const names = await migrationNames();
  const meta = JSON.parse(await readFile(path.join(directory, 'meta/_journal.json'), 'utf8'));
  assert.equal(meta.dialect, 'postgresql');
  assert.deepEqual(meta.entries.map(entry => `${entry.tag}.sql`), names);
});

test('.gitattributes normalizes every text file to LF', async () => {
  const attributes = await readFile(fileURLToPath(new URL('../../../.gitattributes', import.meta.url)), 'utf8');
  const rules = attributes.split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => { const [pattern, ...values] = line.split(/\s+/); return { pattern, values }; });
  assert.ok(
    rules.some(rule => rule.pattern === '*' && rule.values.length === 2 && rule.values.includes('text=auto') && rule.values.includes('eol=lf')),
    '.gitattributes needs the active line "* text=auto eol=lf"',
  );
  assert.deepEqual(rules.filter(rule => rule.pattern.includes('ServerDesk/drizzle/')).map(rule => rule.pattern), [], 'migrations need no own .gitattributes line');
});

const fixtureSql = 'CREATE TABLE fixture(value TEXT);\n--> statement-breakpoint\nCREATE INDEX fixture_value ON fixture(value);\n';

test('LF checksums stay identical', async () => {
  await migrationFixture({ '0000_initial.sql': fixtureSql }, async (database, fixture) => {
    assert.deepEqual(await migrateDatabase(database, { directory: fixture }), { applied: 1, total: 1 });
    const [entry] = await journal(database);
    assert.equal(entry.checksum, sha256(Buffer.from(fixtureSql, 'utf8')), 'an LF file keeps its raw byte checksum');
    assert.deepEqual(await migrateDatabase(database, { directory: fixture }), { applied: 0, total: 1 });
  });
});

test('a migration checked out with CRLF is journaled with its LF checksum', async () => {
  const windows = fixtureSql.replaceAll('\n', '\r\n');
  await migrationFixture({ '0000_initial.sql': windows }, async (database, fixture) => {
    assert.deepEqual(await migrateDatabase(database, { directory: fixture }), { applied: 1, total: 1 });
    const [entry] = await journal(database);
    assert.equal(entry.checksum, sha256(Buffer.from(fixtureSql, 'utf8')));
    assert.notEqual(entry.checksum, sha256(Buffer.from(windows, 'utf8')));
    assert.ok(await exists(database, 'fixture'));
    assert.ok(await exists(database, 'fixture_value'), 'statements are split from the normalized text');
  });
});

// The CRLF form of a migration is not an accepted journal checksum: a journal
// row with it counts as a changed migration, with or without a final line break.
for (const [label, source] of [['with a final line break', fixtureSql], ['without a final line break', 'CREATE TABLE fixture(value TEXT);\nCREATE INDEX fixture_value ON fixture(value);']]) {
  test(`a CRLF-form journal checksum is rejected and the database stays unchanged (${label})`, async () => {
    await migrationFixture({ '0000_initial.sql': source }, async (database, fixture) => {
      await migrateDatabase(database, { directory: fixture });
      await database.exec(sql`UPDATE _serverdesk_migrations SET checksum=${sha256(crlf(Buffer.from(source, 'utf8')))} WHERE name=${'0000_initial.sql'}`);
      const before = await journal(database);
      await writeFile(path.join(fixture, '0001_pending.sql'), 'CREATE TABLE should_not_exist(value TEXT);');
      await assert.rejects(migrateDatabase(database, { directory: fixture }), changedMessage('0000_initial.sql'));
      assert.deepEqual(await journal(database), before, 'the journal stays as it was');
      assert.equal(await exists(database, 'should_not_exist'), false, 'the pending migration is not applied');
    });
  });
}

test('a checksum matching neither the LF nor the CRLF form is rejected', async () => {
  await migrationFixture({ '0000_initial.sql': fixtureSql }, async (database, fixture) => {
    await migrateDatabase(database, { directory: fixture });
    const middle = fixtureSql.indexOf('\n');
    const strayCarriageReturn = fixtureSql.slice(0, middle) + '\r' + fixtureSql.slice(middle);
    assert.notEqual(sha256(Buffer.from(strayCarriageReturn, 'utf8')), sha256(crlf(Buffer.from(fixtureSql, 'utf8'))));
    await database.exec(sql`UPDATE _serverdesk_migrations SET checksum=${sha256(Buffer.from(strayCarriageReturn, 'utf8'))}`);
    await writeFile(path.join(fixture, '0001_pending.sql'), 'CREATE TABLE should_not_exist(value TEXT);');
    await assert.rejects(migrateDatabase(database, { directory: fixture }), changedMessage('0000_initial.sql'));
    assert.equal(await exists(database, 'should_not_exist'), false);
  });
});

test('migrate refuses a schema without a journal and leaves its data alone', async () => {
  await emptyDatabase(async database => {
    await database.exec(sql`CREATE TABLE existing_data(value TEXT NOT NULL)`);
    await database.exec(sql`INSERT INTO existing_data(value) VALUES('preserve me')`);
    await assert.rejects(migrateDatabase(database), { message: noJournalMessage });
    assert.equal((await database.one(sql`SELECT value FROM existing_data`)).value, 'preserve me');
    assert.equal(await exists(database, '_serverdesk_migrations'), false);
  });
});

test('changed applied migration is rejected before any pending schema changes', async () => {
  await migrationFixture({ '0000_initial.sql': 'CREATE TABLE fixture(value TEXT);' }, async (database, fixture) => {
    await migrateDatabase(database, { directory: fixture });
    await writeFile(path.join(fixture, '0000_initial.sql'), 'CREATE TABLE fixture(value TEXT, extra TEXT);');
    await writeFile(path.join(fixture, '0001_pending.sql'), 'CREATE TABLE should_not_exist(value TEXT);');
    await assert.rejects(migrateDatabase(database, { directory: fixture }), changedMessage('0000_initial.sql'));
    assert.equal(await exists(database, 'should_not_exist'), false);
    assert.equal((await database.one(sql`SELECT count(*) AS count FROM _serverdesk_migrations`)).count, 1);
  });
});

test('a journal that does not match the source is rejected', async () => {
  await migrationFixture({
    '0000_initial.sql': 'CREATE TABLE fixture(value TEXT);',
    '0001_second.sql': 'CREATE TABLE second(value TEXT);',
  }, async (database, fixture) => {
    await migrateDatabase(database, { directory: fixture });
    await rm(path.join(fixture, '0001_second.sql'));
    await assert.rejects(migrateDatabase(database, { directory: fixture }), { message: 'The migration journal does not match the source (0001_second.sql). Check for missing or skipped migrations first.' });
    assert.equal((await database.one(sql`SELECT count(*) AS count FROM _serverdesk_migrations`)).count, 2);
  });
});

test('a failed migration rolls back its schema, data and journal entry together', async () => {
  await migrationFixture({
    '0000_initial.sql': 'CREATE TABLE fixture(value TEXT);',
    '0001_failed.sql': "CREATE TABLE partial(value TEXT);\n--> statement-breakpoint\nINSERT INTO fixture(value) VALUES('uncommitted');\n--> statement-breakpoint\nINSERT INTO missing_table(value) VALUES('failure');",
  }, async (database, fixture) => {
    await assert.rejects(migrateDatabase(database, { directory: fixture }), /missing_table/);
    assert.equal(await exists(database, 'partial'), false);
    assert.equal((await database.one(sql`SELECT count(*) AS count FROM fixture`)).count, 0);
    assert.equal((await database.one(sql`SELECT count(*) AS count FROM _serverdesk_migrations`)).count, 1);
    await writeFile(path.join(fixture, '0001_failed.sql'), 'CREATE TABLE recovered(value TEXT);');
    assert.deepEqual(await migrateDatabase(database, { directory: fixture }), { applied: 1, total: 2 }, 'an unapplied failed migration can be repaired');
  });
});

test('the seeds are the first customer, the usage row and the maintenance settings and lock rows, the alarm check lease, the notification dispatcher lease, the vulnerability check settings and lease, the release source row, the Entra account check row, the customer settings row, and nothing else', async () => {
  await emptyDatabase(async database => {
    await migrateDatabase(database);
    const customer = await database.one(sql`SELECT * FROM customers`);
    assert.deepEqual({ ...customer, created_at: 0, updated_at: 0 }, {
      id: firstCustomer, name: 'Standardkunde', status: 'active', contact_name: '', contact_email: '', contact_phone: '', created_at: 0, updated_at: 0,
      audit_retention_days: null, maintenance_days: null, maintenance_start: null, maintenance_duration: null, maintenance_time_zone: null, revision: 0,
    });
    assert.ok(customer.created_at === customer.updated_at && customer.created_at > Date.UTC(2020, 0, 1) && customer.created_at <= Date.now() + 1000, 'the seed time is the migration time in milliseconds');
    const usage = await database.query(sql`SELECT * FROM usage_data`);
    assert.equal(usage.length, 1);
    assert.equal(usage[0].id, 1);
    assert.match(usage[0].instance_id, /^[0-9a-f]{32}$/, 'a random 32-character lowercase hex instance id');
    // 0002_maintenance.sql: the settings row (NULL retention = environment start value, 03:00 UTC) and the free lock.
    assert.deepEqual(await database.query(sql`SELECT * FROM maintenance_settings`), [{ id: 1, audit_days: null, job_days: null, run_at: 180, time_zone: 'UTC', revision: 0, updated_at: null, updated_by: null }]);
    assert.deepEqual(await database.query(sql`SELECT * FROM maintenance_lock`), [{ id: 1, holder: null, run_id: null, acquired_at: null, expires_at: null }]);
    // 0005_alerts.sql: the free lease of the periodic alarm check.
    assert.deepEqual(await database.query(sql`SELECT * FROM alert_sweep`), [{ id: 1, last_started_at: null }]);
    // 0008_notifications.sql: the free lease of the notification dispatcher.
    assert.deepEqual(await database.query(sql`SELECT * FROM notification_dispatch`), [{ id: 1, last_started_at: null }]);
    // 0009_vulnerabilities.sql: the check is off, without a key, and its sync lease is free.
    // 0017_vulnerability_cvelist.sql: the CVEList source is off (cvelist_enabled) and has no run yet (the cvelist_* columns of the lease).
    assert.deepEqual(await database.query(sql`SELECT * FROM vulnerability_settings`), [{ id: 1, enabled: 0, api_key: null, revision: 0, updated_at: null, updated_by: null, cvelist_enabled: 0 }]);
    assert.deepEqual(await database.query(sql`SELECT * FROM vulnerability_sync`), [{ id: 1, lease_holder: null, lease_until: null, requested_at: null, last_started_at: null, last_finished_at: null, last_success_at: null, last_status: null, last_error: null, cvelist_last_finished_at: null, cvelist_last_success_at: null, cvelist_last_status: null, cvelist_last_error: null }]);
    // 0010_release_import.sql: the release source has no token, no lease and no check yet.
    assert.deepEqual(await database.query(sql`SELECT * FROM agent_release_source`), [{ id: 1, lease_holder: null, lease_until: null, requested_at: null, last_started_at: null, last_finished_at: null, last_status: null, last_error: null, dev_builds: false }]);
    // 0027_entra_directory_check.sql: the account check through Microsoft Graph has no lease and no run yet.
    assert.deepEqual(await database.query(sql`SELECT * FROM entra_directory_check`), [{ id: 1, lease_until: null, last_started_at: null, last_finished_at: null, last_result: null, last_ok_at: null, settings_revision: null, checked_count: 0, locked_count: 0, group_change_count: 0, remaining_count: 0 }]);
    // 0040_multiple_customers.sql: a new portal has only the default customer, so "Multiple customers" starts off.
    assert.deepEqual(await database.query(sql`SELECT * FROM customer_settings`), [{ id: 1, multiple_customers: false, revision: 0, updated_at: null, updated_by: null }]);
    const tables = (await database.query(sql`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'_serverdesk_migrations' ORDER BY tablename`)).map(row => row.tablename);
    const filled = [];
    for (const table of tables) if ((await database.one(sql`SELECT count(*) AS n FROM ${sql.ident(table)}`)).n > 0) filled.push(table);
    assert.deepEqual(filled, ['agent_release_source', 'alert_sweep', 'customer_settings', 'customers', 'entra_directory_check', 'maintenance_lock', 'maintenance_settings', 'notification_dispatch', 'usage_data', 'vulnerability_settings', 'vulnerability_sync'], 'no other rows; built-in roles are seeded at runtime');
    const other = await testDatabase({ template: false });
    try {
      await migrateDatabase(other);
      assert.notEqual((await other.one(sql`SELECT instance_id FROM usage_data`)).instance_id, usage[0].instance_id, 'every database gets its own instance id');
    } finally { await other.close(); }
  });
});

// The trigger classification: every P and W row is a trigger with the same
// name; the C rows (customers_insert_settings, customers_update_settings) are
// the CHECK customers_settings_valid.
const classifiedTriggers = [
  // 0001_alert_rule_overrides.sql: cleanup of the overrides of a removed device or a deleted group.
  'alert_rule_overrides_removed_device', 'alert_rule_overrides_removed_group',
  // 0005_alerts.sql: cleanup of the alarms of a removed device.
  'alerts_removed_device',
  'audit_insert_customer', 'audit_insert_device_customer', 'audit_update_customer_immutable', 'audit_update_customer_set',
  'automation_removed_device', 'automation_removed_group', 'automation_runbook_removed_assignment', 'automation_runbook_replaced_assignment',
  'automation_scope_assignments_insert_customer', 'automation_scope_assignments_update_customer', 'automation_templates_insert_customer',
  'automation_templates_insert_runbook_customer', 'automation_templates_update_customer', 'automation_templates_update_runbook_customer',
  'customer_assignments_insert', 'customer_assignments_update', 'customer_installers_insert', 'customer_installers_update_immutable',
  'customer_installers_update_revoked',
  // 0040_multiple_customers.sql: the setting "Multiple customers" (customer_settings).
  'customer_settings_delete', 'customer_settings_update_multiple', 'customers_insert_multiple_customers',
  // 0041_customer_delete.sql drops customers_delete_audit_guard and adds the tombstone, its two
  // append-only triggers and the two triggers that keep a removed id from coming back.
  'customers_delete_tombstone', 'removed_customers_update', 'removed_customers_delete', 'customers_insert_removed_id', 'customers_update_id_removed',
  'customers_delete_assignments', 'customers_delete_catalog_guard',
  'customers_delete_guard', 'customers_delete_installers', 'customers_status_default_guard', 'customers_update_id_assignments',
  'customers_update_id_audit_guard', 'customers_update_id_catalog_guard', 'customers_update_id_guard', 'customers_update_id_installers',
  'device_group_members_insert_customer', 'device_group_members_insert_path', 'device_group_members_insert_target',
  'device_group_members_update_customer', 'device_group_members_update_path', 'device_group_members_update_target',
  'device_groups_delete_hierarchy', 'device_groups_delete_paths', 'device_groups_insert_customer', 'device_groups_insert_customer_disabled',
  'device_groups_insert_hierarchy', 'device_groups_insert_paths', 'device_groups_update_customer', 'device_groups_update_customer_catalog',
  'device_groups_update_customer_disabled', 'device_groups_update_hierarchy', 'device_groups_update_membership_paths', 'device_groups_update_paths',
  // 0004_health_signals.sql: cleanup of the software and ESU rows of a removed device, and of the ESU dates of a deleted group.
  'health_signals_removed_device', 'os_esu_overrides_removed_group',
  // 0007_health_signals_2.sql: cleanup of the driver and autostart rows of a removed device.
  'health_signals_2_removed_device',
  'local_users_delete_customer_assignments',
  // 0008_notifications.sql: cleanup of the notification rules of a deleted group or customer.
  'notification_rules_removed_customer', 'notification_rules_removed_group',
  'rbac_roles_insert_customer', 'rbac_roles_insert_customer_permissions', 'rbac_roles_update_customer', 'rbac_roles_update_customer_permissions',
  'rdp_rtc_no_frames', 'rdp_rtc_no_receipts', 'rdp_rtc_terminal_cleanup', 'role_assignments_insert_customer', 'role_assignments_update_customer',
  'runbooks_insert_customer', 'runbooks_update_customer', 'servers_insert_customer', 'servers_insert_customer_disabled', 'servers_update_customer',
  'servers_update_customer_catalog', 'servers_update_customer_disabled',
  // 0019_agent_plugins.sql: cleanup of the plugin data of a removed device.
  'agent_plugins_removed_device',
  // 0021_agent_integrity_events.sql: cleanup of the integrity events of a removed device.
  'agent_integrity_removed_device',
  // 0003_device_description_tags.sql: cleanup of the tags of a removed device or a deleted group.
  'tags_removed_device', 'tags_removed_group',
  // 0039_customer_scope_overrides.sql: cleanup of the alert rules and ESU dates of a deleted customer.
  'alert_rule_overrides_removed_customer', 'os_esu_overrides_removed_customer',
  'usage_data_delete', 'usage_data_insert', 'usage_data_instance_immutable',
  'user_groups_delete_customer_assignments',
];

// The objects that migration 0038 drops, read from the migration itself.
const licenseMigration = async () => (await migrationNames()).find(name => name.startsWith('0038_'));
async function droppedByLicenseMigration() {
  const text = await readFile(path.join(directory, await licenseMigration()), 'utf8');
  return {
    tables: [...text.matchAll(/DROP TABLE "(\w+)"/g)].map(match => match[1]),
    triggers: [...text.matchAll(/DROP TRIGGER (\w+) ON "(\w+)"/g)].map(match => match[1]),
    functions: [...text.matchAll(/DROP FUNCTION (\w+)\(\)/g)].map(match => match[1]),
  };
}

test('migration 0038 drops the license table, its three triggers and functions, and changes no other table', async () => {
  const dropped = await droppedByLicenseMigration();
  assert.equal(dropped.tables.length, 1, 'one table');
  const [table] = dropped.tables;
  assert.deepEqual(dropped.triggers.sort(), ['delete', 'insert', 'update'].map(kind => `${table}_${kind}`), 'its three triggers');
  assert.deepEqual(dropped.functions.sort(), dropped.triggers, 'their three functions');
  const text = await readFile(path.join(directory, await licenseMigration()), 'utf8');
  assert.deepEqual([...text.matchAll(/^(\w+(?: \w+)?)/gm)].map(match => match[1]).filter(word => !word.startsWith('DROP')), [], 'only DROP statements besides the comments');
  await migratedDatabase(async database => {
    assert.equal(await exists(database, table), false, 'the table is gone');
    assert.deepEqual(await database.query(sql`SELECT proname FROM pg_proc WHERE proname IN (SELECT jsonb_array_elements_text(${JSON.stringify(dropped.functions)}::jsonb))`), [], 'the functions are gone');
  });
});

// The rows of customers, devices, groups, assignments, installers, audit and the
// catalogs written before 0038, also on an instance whose license row was set,
// are the same after it: the migration changes no customer data.
test('migration 0038 keeps every customer row', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'serverdesk-one-edition-'));
  const database = await testDatabase({ template: false });
  try {
    const names = await migrationNames(), last = await licenseMigration(), [table] = (await droppedByLicenseMigration()).tables;
    const earlier = names.filter(name => name < last);
    for (const name of earlier) await copyFile(path.join(directory, name), path.join(temporary, name));
    await migrateDatabase(database, { directory: temporary });
    for (const step of fixtureRows) await database.exec(step);
    await database.exec(installer('inst-keep'));
    await database.exec(sql`INSERT INTO device_group_members(server_id,group_id) VALUES(${ids.deviceB},${ids.groupB})`);
    await database.exec(sql`INSERT INTO customer_assignments(customer_id,principal_type,principal_id,created_at,created_by) VALUES(${ids.b},'user',${ids.user},${at},'fixture'),(${firstCustomer},'group',${ids.team},${at},'fixture')`);
    await database.exec(sql`INSERT INTO audit(id,at,actor,action,target,scope,customer_id) VALUES(9101,${at},'a','Kunde angelegt','Kunde B','portal',${ids.b})`);
    await database.exec(sql`INSERT INTO runbooks(id,name,description,created_at,created_by,customer_id) VALUES('rb-keep','Behalten','',${at},'fixture',${ids.b})`);
    await database.exec(sql`UPDATE ${sql.ident(table)} SET activated_at=${at} WHERE id=1`);
    const snapshot = async () => {
      const state = {};
      for (const name of ['customers', 'servers', 'device_groups', 'device_group_members', 'customer_assignments', 'customer_installers', 'audit', 'runbooks']) state[name] = await database.query(sql`SELECT * FROM ${sql.ident(name)} ORDER BY 1`);
      return state;
    };
    const before = await snapshot();
    assert.equal(before.customers.length, 3, 'the fixture has three customers');
    await copyFile(path.join(directory, last), path.join(temporary, last));
    assert.deepEqual(await migrateDatabase(database, { directory: temporary }), { applied: 1, total: earlier.length + 1 });
    assert.deepEqual(await snapshot(), before, 'every customer row is unchanged');
    assert.equal(await exists(database, table), false, 'the license table is gone');
  } finally {
    await database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

// 0040_multiple_customers.sql (docs/customers.md, "Multiple customers"), found by
// its name so a renumbering keeps the tests. beforeMultipleCustomers migrates a
// fresh database with every migration before it; apply() adds it.
const multipleCustomersMigration = async () => (await migrationNames()).find(name => name.endsWith('_multiple_customers.sql'));
async function beforeMultipleCustomers(run) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'serverdesk-multiple-customers-'));
  const database = await testDatabase({ template: false });
  try {
    const names = await migrationNames(), migration = await multipleCustomersMigration();
    assert.ok(migration, 'the migration of the setting is shipped');
    const earlier = names.filter(name => name < migration);
    for (const name of earlier) await copyFile(path.join(directory, name), path.join(temporary, name));
    await migrateDatabase(database, { directory: temporary });
    const apply = async () => {
      await copyFile(path.join(directory, migration), path.join(temporary, migration));
      assert.deepEqual(await migrateDatabase(database, { directory: temporary }), { applied: 1, total: earlier.length + 1 });
    };
    return await run(database, apply);
  } finally {
    await database.close();
    await rm(temporary, { recursive: true, force: true });
  }
}
const settingRow = database => database.query(sql`SELECT * FROM customer_settings`);
const customerTables = ['customers', 'servers', 'device_groups', 'device_group_members', 'customer_assignments', 'customer_installers', 'audit'];
async function customerRows(database) {
  const state = {};
  for (const name of customerTables) state[name] = await database.query(sql`SELECT * FROM ${sql.ident(name)} ORDER BY 1`);
  return state;
}
const raised = expected => error => error.code === 'P0001' && error.message === expected;

test('the multiple customers migration starts off when only the default customer exists, with its devices, groups and installers', async () => {
  await beforeMultipleCustomers(async (database, apply) => {
    await database.exec(fixtureRows[2]);
    await database.exec(fixtureRows[4]);
    await database.exec(installer('inst-default'));
    await database.exec(sql`INSERT INTO device_group_members(server_id,group_id) VALUES(${ids.deviceA},${ids.groupA})`);
    const before = await customerRows(database);
    await apply();
    assert.deepEqual(await settingRow(database), [{ id: 1, multiple_customers: false, revision: 0, updated_at: null, updated_by: null }], 'off');
    assert.deepEqual(await customerRows(database), before, 'every row of the default customer is unchanged');
  });
});

test('the multiple customers migration starts on when another customer exists and changes no other row', async () => {
  await beforeMultipleCustomers(async (database, apply) => {
    for (const step of fixtureRows) await database.exec(step);
    await database.exec(installer('inst-keep'));
    await database.exec(sql`INSERT INTO device_group_members(server_id,group_id) VALUES(${ids.deviceB},${ids.groupB})`);
    await database.exec(sql`INSERT INTO customer_assignments(customer_id,principal_type,principal_id,created_at,created_by) VALUES(${ids.b},'user',${ids.user},${at},'fixture'),(${firstCustomer},'group',${ids.team},${at},'fixture')`);
    await database.exec(sql`INSERT INTO audit(id,at,actor,action,target,scope,customer_id) VALUES(9201,${at},'a','Kunde angelegt','Kunde B','portal',${ids.b})`);
    const before = await customerRows(database);
    assert.equal(before.customers.length, 3, 'the fixture has the default customer, customer B and the deactivated customer D');
    await apply();
    assert.deepEqual(await settingRow(database), [{ id: 1, multiple_customers: true, revision: 0, updated_at: null, updated_by: null }], 'on');
    assert.deepEqual(await customerRows(database), before, 'customers, devices, groups, assignments, installers and audit rows are unchanged');
  });
});

test('the multiple customers triggers: no other customer while off, no switch-off while one exists, the row stays', async () => {
  await migratedDatabase(async database => {
    const other = randomUUID(), insertOther = () => database.exec(sql`INSERT INTO customers(id,name,created_at,updated_at) VALUES(${other},'Kunde B',${at},${at})`);
    await assert.rejects(insertOther(), raised('multiple-customers-off'), 'an insert while off');
    assert.equal((await database.one(sql`SELECT count(*) AS n FROM customers`)).n, 1, 'only the default customer');
    await database.exec(sql`UPDATE customers SET name='Hauptkunde' WHERE id=${firstCustomer}`);
    await database.exec(multipleCustomersOn);
    await insertOther();
    await assert.rejects(database.exec(sql`UPDATE customer_settings SET multiple_customers=false WHERE id=1`), raised('multiple-customers-in-use'), 'a switch-off with another customer');
    await database.exec(sql`UPDATE customers SET status='disabled' WHERE id=${other}`);
    await assert.rejects(database.exec(sql`UPDATE customer_settings SET multiple_customers=false WHERE id=1`), raised('multiple-customers-in-use'), 'a deactivated customer counts too');
    assert.equal((await settingRow(database))[0].multiple_customers, true, 'the setting stays on');
    await assert.rejects(database.exec(sql`DELETE FROM customer_settings`), raised('customer-settings-protected'), 'the row cannot be deleted');
    await assert.rejects(database.exec(sql`INSERT INTO customer_settings(id,multiple_customers) VALUES(2,true)`), error => error.code === '23514' && error.constraint_name === 'customer_settings_single_row', 'one row');
    await assert.rejects(database.exec(sql`UPDATE customer_settings SET revision=-1 WHERE id=1`), error => error.code === '23514' && error.constraint_name === 'customer_settings_revision', 'no negative revision');
    // Without another customer the setting goes off again.
    await database.exec(sql`DELETE FROM customers WHERE id=${other}`);
    await database.exec(sql`UPDATE customer_settings SET multiple_customers=false,revision=revision+1 WHERE id=1`);
    assert.deepEqual((await settingRow(database)).map(row => [row.multiple_customers, row.revision]), [[false, 1]]);
  });
});

test('a concurrent customer create and switch-off cannot both commit', async () => {
  await migratedDatabase(async database => {
    const customer = id => sql`INSERT INTO customers(id,name,created_at,updated_at) VALUES(${id},${'Rennen ' + id},${at},${at})`;
    const switchOff = sql`UPDATE customer_settings SET multiple_customers=false WHERE id=1`;
    // Runs first in an open transaction, starts second while it holds its rows, then commits the first.
    async function race(first, second) {
      let started, release;
      const holding = new Promise(resolve => { started = resolve; }), held = new Promise(resolve => { release = resolve; });
      const transaction = database.transaction(async tx => { await tx.exec(first); started(); await held; });
      await holding;
      const result = database.exec(second).then(() => null, error => error);
      await new Promise(resolve => setTimeout(resolve, 300));
      release();
      await transaction;
      return result;
    }
    await database.exec(multipleCustomersOn);
    // The create holds the setting row FOR SHARE: the switch-off waits and then sees the customer.
    const created = randomUUID();
    const refusedOff = await race(customer(created), switchOff);
    assert.ok(refusedOff && raised('multiple-customers-in-use')(refusedOff), `the switch-off is refused: ${refusedOff?.message}`);
    assert.deepEqual([(await settingRow(database))[0].multiple_customers, (await database.one(sql`SELECT count(*) AS n FROM customers WHERE id=${created}`)).n], [true, 1], 'the customer exists and the setting stays on');
    await database.exec(sql`DELETE FROM customers WHERE id=${created}`);
    // The switch-off holds the setting row: the create waits and then finds the setting off.
    const late = randomUUID();
    const refusedCreate = await race(switchOff, customer(late));
    assert.ok(refusedCreate && raised('multiple-customers-off')(refusedCreate), `the create is refused: ${refusedCreate?.message}`);
    assert.deepEqual([(await settingRow(database))[0].multiple_customers, (await database.one(sql`SELECT count(*) AS n FROM customers WHERE id=${late}`)).n], [false, 0], 'the setting is off and no customer was created');
  });
});

test('the trigger names equal the classification without the constraint rows', async () => {
  assert.equal(classifiedTriggers.length, 90);
  assert.equal(classifiedTriggers.includes('customers_delete_audit_guard'), false, 'the audit guard of the delete is gone');
  await migratedDatabase(async database => {
    const names = (await database.query(sql`SELECT tgname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal ORDER BY tgname`)).map(row => row.tgname);
    assert.deepEqual(names, [...classifiedTriggers].sort());
    assert.equal(names.some(name => /^customers_(?:insert|update)_settings$/.test(name)), false, 'the settings rules are a CHECK, not a trigger');
  });
});

// Fixture rows: customer B (active), customer D (disabled), a device and a
// group of each active customer, and one user and user group.
const ids = {
  b: '00000000-0000-4000-8000-0000000000b0', d: '00000000-0000-4000-8000-0000000000d0',
  deviceA: '10000000-0000-4000-8000-00000000000a', deviceB: '10000000-0000-4000-8000-00000000000b',
  groupA: '20000000-0000-4000-8000-00000000000a', groupB: '20000000-0000-4000-8000-00000000000b',
  user: '30000000-0000-4000-8000-000000000001', team: '30000000-0000-4000-8000-000000000002',
  missing: '99999999-0000-4000-8000-000000000000',
};
const at = 1_700_000_000_000;
const fixtureRows = [
  sql`INSERT INTO customers(id,name,created_at,updated_at) VALUES(${ids.b},'Kunde B',${at},${at})`,
  sql`INSERT INTO customers(id,name,status,created_at,updated_at) VALUES(${ids.d},'Kunde D','disabled',${at},${at})`,
  sql`INSERT INTO servers(id,name,token_hash,created_at,customer_id) VALUES(${ids.deviceA},'Gerät A','token-a',${at},${firstCustomer})`,
  sql`INSERT INTO servers(id,name,token_hash,created_at,customer_id) VALUES(${ids.deviceB},'Gerät B','token-b',${at},${ids.b})`,
  sql`INSERT INTO device_groups(id,name,created_at,customer_id) VALUES(${ids.groupA},'Gruppe A',${at},${firstCustomer})`,
  sql`INSERT INTO device_groups(id,name,created_at,customer_id) VALUES(${ids.groupB},'Gruppe B',${at},${ids.b})`,
  sql`INSERT INTO local_users(id,username,display_name,auth_principal,auth_email,status,created_at,updated_at) VALUES(${ids.user},'fixture','Fixture','private:fixture@example.test','fixture@example.test','active',${at},${at})`,
  sql`INSERT INTO user_groups(id,name,created_at) VALUES(${ids.team},'Team',${at})`,
];
const group = (id, parent, customer = firstCustomer) => sql`INSERT INTO device_groups(id,name,created_at,customer_id,parent_id) VALUES(${id},${'Gruppe ' + id},${at},${customer},${parent})`;
const installer = (id, extra = sql``) => sql`INSERT INTO customer_installers(id,customer_id,group_id,name,key_hash,mode,expires_at,created_at,created_by) VALUES(${id},${firstCustomer},NULL,'Rollout',${'key-' + id},'ReadOnly',${at + 86_400_000},${at},'fixture')${extra}`;
const rdpSession = (id, transport) => sql`INSERT INTO rdp_sessions(id,server_id,principal,mfa_hash,key_hash,created_at,last_presence,expires_at,transport) VALUES(${id},${ids.deviceA},'private:fixture','mfa','key',${at},${at},${at + 60_000},${transport})`;
const chain = prefix => Array.from({ length: 5 }, (_, depth) => group(`${prefix}-${depth}`, depth ? `${prefix}-${depth - 1}` : null));

// The fixture's second customers exist only while "Multiple customers" is on
// (0040_multiple_customers.sql); a database migrated before it has no such row.
const multipleCustomersOn = sql`UPDATE customer_settings SET multiple_customers=true WHERE id=1`;

// Runs setup and then statement in one transaction that is always rolled back,
// and returns the error of statement (or null).
const rollback = Symbol('rollback');
async function attempt(database, setup, statement) {
  let failure = null;
  await database.transaction(async tx => {
    for (const step of [multipleCustomersOn, ...fixtureRows, ...setup]) await tx.exec(step);
    try { await tx.exec(statement); } catch (error) { failure = error; }
    throw rollback;
  }).catch(error => { if (error !== rollback) throw error; });
  return failure;
}

// One case per P literal: the documented input raises exactly that literal.
const literalCases = [
  ['customer-missing', [], sql`INSERT INTO servers(id,name,token_hash,created_at,customer_id) VALUES(${randomUUID()},'X','t',${at},${ids.missing})`],
  ['customer-mismatch', [], sql`INSERT INTO device_group_members(server_id,group_id) VALUES(${ids.deviceA},${ids.groupB})`],
  ['audit-customer-immutable', [sql`INSERT INTO audit(id,at,actor,action,target,scope,customer_id) VALUES(9001,${at},'a','b','c','portal',${firstCustomer})`], sql`UPDATE audit SET customer_id=${ids.b} WHERE id=9001`],
  ['customer-catalog-mismatch', [sql`INSERT INTO automation_templates(id,kind,slot,name,payload,created_by,created_at,customer_id) VALUES('tpl-b','desired','default','B','{}','fixture',${at},${ids.b})`],
    sql`INSERT INTO automation_scope_assignments(id,kind,slot,scope_type,scope_id,template_id,actor,auth_version,created_at) VALUES('scope-1','desired','default','group',${ids.groupA},'tpl-b','fixture',1,${at})`],
  ['customer-disabled', [], sql`INSERT INTO servers(id,name,token_hash,created_at,customer_id) VALUES(${randomUUID()},'X','t',${at},${ids.d})`],
  ['customer-catalog-immutable', [sql`INSERT INTO runbooks(id,name,description,created_at,created_by,customer_id) VALUES('rb-a','A','',${at},'fixture',${firstCustomer})`], sql`UPDATE runbooks SET customer_id=${ids.b} WHERE id='rb-a'`],
  ['customer-assignment-subject-missing', [], sql`INSERT INTO customer_assignments(customer_id,principal_type,principal_id,created_at,created_by) VALUES(${firstCustomer},'user',${ids.missing},${at},'fixture')`],
  ['customer-installer-group-mismatch', [], sql`INSERT INTO customer_installers(id,customer_id,group_id,name,key_hash,mode,expires_at,created_at,created_by) VALUES('inst-x',${firstCustomer},${ids.groupB},'Rollout','key-x','ReadOnly',${at + 86_400_000},${at},'fixture')`],
  ['customer-installer-immutable', [installer('inst-1')], sql`UPDATE customer_installers SET key_hash='other' WHERE id='inst-1'`],
  ['customer-installer-revoked', [installer('inst-2'), sql`UPDATE customer_installers SET revoked_at=${at},revoked_by='fixture' WHERE id='inst-2'`], sql`UPDATE customer_installers SET revoked_at=NULL WHERE id='inst-2'`],
  ['customer-in-use', [], sql`DELETE FROM customers WHERE id=${ids.b}`],
  ['customer-default-protected', [], sql`DELETE FROM customers WHERE id=${firstCustomer}`],
  ['device-group-membership-path-conflict', [group('child-a', ids.groupA), sql`INSERT INTO device_group_members(server_id,group_id) VALUES(${ids.deviceA},${ids.groupA})`], sql`INSERT INTO device_group_members(server_id,group_id) VALUES(${ids.deviceA},'child-a')`],
  ['device-group-member-missing', [], sql`INSERT INTO device_group_members(server_id,group_id) VALUES(${ids.missing},${ids.groupA})`],
  ['device-group-has-children', [group('child-b', ids.groupA)], sql`DELETE FROM device_groups WHERE id=${ids.groupA}`],
  ['device-group-parent-missing', [], group('orphan', ids.missing)],
  ['device-group-cycle', [group('child-c', ids.groupA)], sql`UPDATE device_groups SET parent_id='child-c' WHERE id=${ids.groupA}`],
  ['device-group-depth-limit', chain('deep'), group('deep-5', 'deep-4')],
  ['customer-role-permissions', [], sql`INSERT INTO rbac_roles(id,name,permissions,created_at,customer_id) VALUES('role-x','X','["portal.operator"]',${at},${firstCustomer})`],
  ['customer-role-scope', [sql`INSERT INTO rbac_roles(id,name,permissions,created_at,customer_id) VALUES('role-a','A','["view"]',${at},${firstCustomer})`],
    sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES('ra-1','user',${ids.user},'role-a','global','*',${at},'fixture')`],
  ['Direct WebRTC sessions cannot store stream payloads', [rdpSession('rdp-1', 'webrtc')], sql`INSERT INTO rdp_frames(session_id,direction,seq,data,created_at) VALUES('rdp-1','in',1,'x',${at})`],
  ['Direct WebRTC sessions cannot store stream receipts', [rdpSession('rdp-2', 'webrtc')], sql`INSERT INTO rdp_receipts(session_id,direction,seq,digest) VALUES('rdp-2','in',1,'x')`],
  ['usage-data-protected', [], sql`DELETE FROM usage_data`],
  ['usage-instance-immutable', [], sql`UPDATE usage_data SET instance_id=${'0'.repeat(32)} WHERE id=1`],
];

test('every RAISE EXCEPTION literal of the baseline has a case, and each case raises exactly its literal', async () => {
  // The literals of the trigger functions that migration 0038 drops are gone after all migrations.
  const dropped = await droppedByLicenseMigration(), baseline = await readFile(path.join(directory, '0000_baseline.sql'), 'utf8');
  const droppedLiterals = new Set([...baseline.matchAll(/CREATE FUNCTION (\w+)\(\)[^$]*\$\$([\s\S]*?)\$\$/g)].filter(match => dropped.functions.includes(match[1])).flatMap(match => [...match[2].matchAll(/RAISE EXCEPTION '([^']+)'/g)].map(raised => raised[1])));
  assert.equal(droppedLiterals.size, 3, 'the three literals of the dropped license functions');
  const literals = [...new Set([...baseline.matchAll(/RAISE EXCEPTION '([^']+)'/g)].map(match => match[1]))].filter(literal => !droppedLiterals.has(literal)).sort();
  assert.deepEqual(literalCases.map(([literal]) => literal).sort(), literals, 'one case per literal');
  await migratedDatabase(async database => {
    for (const [literal, setup, statement] of literalCases) {
      const failure = await attempt(database, setup, statement);
      assert.ok(failure, `${literal}: the statement is refused`);
      assert.deepEqual([failure.code, failure.message], ['P0001', literal], literal);
    }
  });
});

// One case per W trigger: the statement succeeds and the trigger did its writes.
const count = async (tx, statement) => (await tx.one(statement)).n;
const writeCases = [
  ['audit_insert_device_customer', [], sql`INSERT INTO audit(id,at,actor,action,target,server_id,scope) VALUES(9002,${at},'a','b','c',${ids.deviceB},'device')`,
    async tx => assert.equal((await tx.one(sql`SELECT customer_id FROM audit WHERE id=9002`)).customer_id, ids.b, 'the device row gets the customer of its device')],
  ['automation_removed_device', [
    sql`INSERT INTO automation_templates(id,kind,slot,name,payload,created_by,created_at) VALUES('tpl-1','desired','default','T','{}','fixture',${at})`,
    sql`INSERT INTO automation_scope_assignments(id,kind,slot,scope_type,scope_id,template_id,actor,auth_version,created_at) VALUES('scope-d','desired','default','device',${ids.deviceA},'tpl-1','fixture',1,${at})`,
    sql`INSERT INTO automation_device_state(server_id,kind,slot,status,updated_at) VALUES(${ids.deviceA},'desired','default','applied',${at})`,
  ], sql`UPDATE servers SET revoked=1 WHERE id=${ids.deviceA}`,
  async tx => assert.deepEqual([await count(tx, sql`SELECT count(*) AS n FROM automation_scope_assignments WHERE scope_id=${ids.deviceA}`), await count(tx, sql`SELECT count(*) AS n FROM automation_device_state WHERE server_id=${ids.deviceA}`)], [0, 0])],
  ['automation_removed_group', [
    sql`INSERT INTO automation_templates(id,kind,slot,name,payload,created_by,created_at) VALUES('tpl-2','desired','default','T','{}','fixture',${at})`,
    sql`INSERT INTO automation_scope_assignments(id,kind,slot,scope_type,scope_id,template_id,actor,auth_version,created_at) VALUES('scope-g','desired','default','group',${ids.groupA},'tpl-2','fixture',1,${at})`,
  ], sql`DELETE FROM device_groups WHERE id=${ids.groupA}`,
  async tx => assert.equal(await count(tx, sql`SELECT count(*) AS n FROM automation_scope_assignments WHERE id='scope-g'`), 0)],
  ['automation_runbook_removed_assignment', [
    sql`INSERT INTO automation_templates(id,kind,slot,name,payload,created_by,created_at) VALUES('tpl-3','desired','default','T','{}','fixture',${at})`,
    sql`INSERT INTO automation_scope_assignments(id,kind,slot,scope_type,scope_id,template_id,actor,auth_version,created_at) VALUES('scope-r','desired','default','group',${ids.groupA},'tpl-3','fixture',1,${at})`,
    sql`INSERT INTO automation_runbook_schedules(assignment_id,next_due,created_at) VALUES('scope-r',${at},${at})`,
  ], sql`DELETE FROM automation_scope_assignments WHERE id='scope-r'`,
  async tx => assert.equal(await count(tx, sql`SELECT count(*) AS n FROM automation_runbook_schedules WHERE assignment_id='scope-r'`), 0)],
  ['automation_runbook_replaced_assignment', [
    sql`INSERT INTO automation_templates(id,kind,slot,name,payload,created_by,created_at) VALUES('tpl-4','desired','default','T','{}','fixture',${at})`,
    sql`INSERT INTO automation_scope_assignments(id,kind,slot,scope_type,scope_id,template_id,actor,auth_version,created_at) VALUES('scope-s','desired','default','group',${ids.groupA},'tpl-4','fixture',1,${at})`,
    sql`INSERT INTO automation_runbook_schedules(assignment_id,next_due,created_at) VALUES('scope-s',${at},${at})`,
  ], sql`UPDATE automation_scope_assignments SET id='scope-t' WHERE id='scope-s'`,
  async tx => assert.equal(await count(tx, sql`SELECT count(*) AS n FROM automation_runbook_schedules WHERE assignment_id IN ('scope-s','scope-t')`), 0)],
  ['customers_delete_assignments', [
    sql`INSERT INTO customers(id,name,created_at,updated_at) VALUES('cust-e1','Leer 1',${at},${at})`,
    sql`INSERT INTO customer_assignments(customer_id,principal_type,principal_id,created_at,created_by) VALUES('cust-e1','user',${ids.user},${at},'fixture')`,
  ], sql`DELETE FROM customers WHERE id='cust-e1'`,
  async tx => assert.equal(await count(tx, sql`SELECT count(*) AS n FROM customer_assignments WHERE customer_id='cust-e1'`), 0)],
  ['customers_delete_installers', [
    sql`INSERT INTO customers(id,name,created_at,updated_at) VALUES('cust-e2','Leer 2',${at},${at})`,
    sql`INSERT INTO customer_installers(id,customer_id,name,key_hash,mode,expires_at,created_at,created_by) VALUES('inst-e2','cust-e2','Rollout','key-e2','ReadOnly',${at + 86_400_000},${at},'fixture')`,
  ], sql`DELETE FROM customers WHERE id='cust-e2'`,
  async tx => assert.equal(await count(tx, sql`SELECT count(*) AS n FROM customer_installers WHERE id='inst-e2'`), 0)],
  ['customers_delete_tombstone', [sql`INSERT INTO customers(id,name,created_at,updated_at) VALUES('cust-e5','Leer 5',${at},${at})`],
    sql`DELETE FROM customers WHERE id='cust-e5'`,
    async tx => {
      const [row] = await tx.query(sql`SELECT id,name,removed_at FROM removed_customers WHERE id='cust-e5'`);
      assert.deepEqual([row?.id, row?.name], ['cust-e5', 'Leer 5'], 'the tombstone keeps the id and the last name');
      assert.ok(Number(row.removed_at) > at, 'removed_at is the time of the delete in ms');
    }],
  ['customers_update_id_assignments', [
    sql`INSERT INTO customers(id,name,created_at,updated_at) VALUES('cust-e3','Leer 3',${at},${at})`,
    sql`INSERT INTO customer_assignments(customer_id,principal_type,principal_id,created_at,created_by) VALUES('cust-e3','group',${ids.team},${at},'fixture')`,
  ], sql`UPDATE customers SET id='cust-e3-new' WHERE id='cust-e3'`,
  async tx => assert.equal(await count(tx, sql`SELECT count(*) AS n FROM customer_assignments WHERE customer_id IN ('cust-e3','cust-e3-new')`), 0)],
  ['customers_update_id_installers', [
    sql`INSERT INTO customers(id,name,created_at,updated_at) VALUES('cust-e4','Leer 4',${at},${at})`,
    sql`INSERT INTO customer_installers(id,customer_id,name,key_hash,mode,expires_at,created_at,created_by) VALUES('inst-e4','cust-e4','Rollout','key-e4','ReadOnly',${at + 86_400_000},${at},'fixture')`,
  ], sql`UPDATE customers SET id='cust-e4-new' WHERE id='cust-e4'`,
  async tx => assert.equal(await count(tx, sql`SELECT count(*) AS n FROM customer_installers WHERE id='inst-e4'`), 0)],
  ['device_groups_insert_paths', [group('p-1', ids.groupA)], group('p-2', 'p-1'),
    async tx => assert.deepEqual((await tx.query(sql`SELECT ancestor_id,depth FROM device_group_paths WHERE group_id='p-2' ORDER BY depth`)).map(row => [row.ancestor_id, row.depth]), [['p-2', 0], ['p-1', 1], [ids.groupA, 2]])],
  ['device_groups_update_paths', [group('q-1', ids.groupA), group('q-2', 'q-1')], sql`UPDATE device_groups SET parent_id=NULL WHERE id='q-1'`,
    async tx => assert.deepEqual((await tx.query(sql`SELECT ancestor_id,depth FROM device_group_paths WHERE group_id='q-2' ORDER BY depth`)).map(row => [row.ancestor_id, row.depth]), [['q-2', 0], ['q-1', 1]])],
  ['device_groups_delete_paths', [group('r-1', ids.groupA)], sql`DELETE FROM device_groups WHERE id='r-1'`,
    async tx => assert.equal(await count(tx, sql`SELECT count(*) AS n FROM device_group_paths WHERE group_id='r-1' OR ancestor_id='r-1'`), 0)],
  ['local_users_delete_customer_assignments', [sql`INSERT INTO customer_assignments(customer_id,principal_type,principal_id,created_at,created_by) VALUES(${firstCustomer},'user',${ids.user},${at},'fixture')`],
    sql`DELETE FROM local_users WHERE id=${ids.user}`,
    async tx => assert.equal(await count(tx, sql`SELECT count(*) AS n FROM customer_assignments WHERE principal_id=${ids.user}`), 0)],
  ['user_groups_delete_customer_assignments', [sql`INSERT INTO customer_assignments(customer_id,principal_type,principal_id,created_at,created_by) VALUES(${firstCustomer},'group',${ids.team},${at},'fixture')`],
    sql`DELETE FROM user_groups WHERE id=${ids.team}`,
    async tx => assert.equal(await count(tx, sql`SELECT count(*) AS n FROM customer_assignments WHERE principal_id=${ids.team}`), 0)],
  ['rdp_rtc_terminal_cleanup', [rdpSession('rdp-3', 'webrtc'), sql`INSERT INTO rdp_rtc_sessions(session_id,offer) VALUES('rdp-3',${'o'.repeat(24)})`],
    sql`UPDATE rdp_sessions SET state='closed' WHERE id='rdp-3'`,
    async tx => assert.equal(await count(tx, sql`SELECT count(*) AS n FROM rdp_rtc_sessions WHERE session_id='rdp-3'`), 0)],
  ['agent_plugins_removed_device', [ids.deviceA, ids.deviceB].flatMap(device => [
    sql`INSERT INTO device_plugin_data(server_id,plugin,operation,data,summary,collected_at,received_at) VALUES(${device},'dhcp','scopes','{}','[]',${at},${at})`,
    sql`INSERT INTO device_dns_zone_records(server_id,zone,data,record_count,truncated,collected_at,received_at) VALUES(${device},'corp.example','{}',0,false,${at},${at})`]),
    sql`UPDATE servers SET revoked=1 WHERE id=${ids.deviceA}`,
    async tx => {
      assert.deepEqual([await count(tx, sql`SELECT count(*) AS n FROM device_plugin_data WHERE server_id=${ids.deviceA}`), await count(tx, sql`SELECT count(*) AS n FROM device_plugin_data WHERE server_id=${ids.deviceB}`)], [0, 1], 'only the removed device loses its plugin data');
      assert.deepEqual([await count(tx, sql`SELECT count(*) AS n FROM device_dns_zone_records WHERE server_id=${ids.deviceA}`), await count(tx, sql`SELECT count(*) AS n FROM device_dns_zone_records WHERE server_id=${ids.deviceB}`)], [0, 1], 'only the removed device loses its DNS zone records');
    }],
  ['agent_integrity_removed_device', [ids.deviceA, ids.deviceB].map(device => sql`INSERT INTO agent_integrity_events(id,server_id,event_id,kind,occurred_at,received_at) VALUES(${'integrity-' + device},${device},'event-1','service-stopped',${at},${at})`),
    sql`UPDATE servers SET revoked=1 WHERE id=${ids.deviceA}`,
    async tx => assert.deepEqual([await count(tx, sql`SELECT count(*) AS n FROM agent_integrity_events WHERE server_id=${ids.deviceA}`), await count(tx, sql`SELECT count(*) AS n FROM agent_integrity_events WHERE server_id=${ids.deviceB}`)], [0, 1], 'only the removed device loses its integrity events')],
];

test('every W trigger does its writes', async () => {
  const writers = ['agent_integrity_removed_device', 'agent_plugins_removed_device', 'audit_insert_device_customer', 'automation_removed_device', 'automation_removed_group', 'automation_runbook_removed_assignment', 'automation_runbook_replaced_assignment',
    'customers_delete_assignments', 'customers_delete_installers', 'customers_delete_tombstone', 'customers_update_id_assignments', 'customers_update_id_installers', 'device_groups_delete_paths',
    'device_groups_insert_paths', 'device_groups_update_paths', 'local_users_delete_customer_assignments', 'rdp_rtc_terminal_cleanup', 'user_groups_delete_customer_assignments'];
  assert.deepEqual(writeCases.map(([name]) => name).sort(), writers, 'one case per W trigger');
  await migratedDatabase(async database => {
    for (const [name, setup, statement, check] of writeCases) {
      await database.transaction(async tx => {
        for (const step of [multipleCustomersOn, ...fixtureRows, ...setup]) await tx.exec(step);
        await tx.exec(statement);
        await check(tx);
        throw rollback;
      }).catch(error => { if (error !== rollback) throw Object.assign(error, { message: `${name}: ${error.message}` }); });
    }
  });
});

// 0041_customer_delete.sql (docs/customers.md, "Delete a customer"), found by its name.
const customerDeleteMigration = async () => (await migrationNames()).find(name => name.endsWith('_customer_delete.sql'));
const removedRow = (database, id) => database.query(sql`SELECT id,name FROM removed_customers WHERE id=${id}`);
// Customer X with nothing that keeps it, inside the fixture of attempt(): "Multiple customers" on, customers B and D.
const customerX = '00000000-0000-4000-8000-0000000000e0';
const insertX = sql`INSERT INTO customers(id,name,created_at,updated_at) VALUES(${customerX},'Kunde X',${at},${at})`;

test('the customer delete migration adds removed_customers and changes no existing row', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'serverdesk-customer-delete-'));
  const database = await testDatabase({ template: false });
  try {
    const names = await migrationNames(), migration = await customerDeleteMigration();
    assert.ok(migration, 'the migration of the customer delete is shipped');
    const earlier = names.filter(name => name < migration);
    for (const name of earlier) await copyFile(path.join(directory, name), path.join(temporary, name));
    await migrateDatabase(database, { directory: temporary });
    await database.exec(multipleCustomersOn);
    for (const step of fixtureRows) await database.exec(step);
    await database.exec(installer('inst-keep'));
    await database.exec(sql`INSERT INTO customer_assignments(customer_id,principal_type,principal_id,created_at,created_by) VALUES(${ids.b},'user',${ids.user},${at},'fixture')`);
    await database.exec(sql`INSERT INTO audit(id,at,actor,action,target,scope,customer_id) VALUES(9301,${at},'a','Kunde angelegt','Kunde B','portal',${ids.b})`);
    await database.exec(sql`INSERT INTO runbooks(id,name,description,created_at,created_by,customer_id,archived) VALUES('rb-old','Alt','',${at},'fixture',${ids.b},1)`);
    const snapshot = async () => {
      const state = {};
      for (const name of [...customerTables, 'runbooks', 'customer_settings']) state[name] = await database.query(sql`SELECT * FROM ${sql.ident(name)} ORDER BY 1`);
      return state;
    };
    const before = await snapshot();
    await copyFile(path.join(directory, migration), path.join(temporary, migration));
    assert.deepEqual(await migrateDatabase(database, { directory: temporary }), { applied: 1, total: earlier.length + 1 });
    assert.deepEqual(await snapshot(), before, 'customers, devices, groups, assignments, installers, audit, runbooks and the setting are unchanged');
    assert.deepEqual(await database.query(sql`SELECT * FROM removed_customers`), [], 'no tombstone yet');
    const columns = await database.query(sql`SELECT column_name,data_type,is_nullable FROM information_schema.columns WHERE table_name='removed_customers' ORDER BY ordinal_position`);
    assert.deepEqual(columns.map(column => [column.column_name, column.data_type, column.is_nullable]), [['id', 'text', 'NO'], ['name', 'text', 'NO'], ['removed_at', 'bigint', 'NO']]);
    const functions = (await database.query(sql`SELECT proname FROM pg_proc WHERE proname='customers_delete_audit_guard'`)).length;
    assert.equal(functions, 0, 'the audit guard function is dropped');
  } finally {
    await database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test('a customer with audit rows, a revoked device and archived catalog entries is deleted, its history keeps the id, and its configuration goes with it', async () => {
  await migratedDatabase(async database => {
    await database.exec(multipleCustomersOn);
    for (const step of fixtureRows) await database.exec(step);
    await database.exec(insertX);
    const revokedDevice = '10000000-0000-4000-8000-0000000000e0';
    const history = [
      sql`INSERT INTO audit(id,at,actor,action,target,scope,customer_id) VALUES(9401,${at},'a','Kunde angelegt','Kunde X','portal',${customerX})`,
      sql`INSERT INTO servers(id,name,token_hash,created_at,customer_id) VALUES(${revokedDevice},'Gerät X','token-x',${at},${customerX})`,
      sql`UPDATE servers SET revoked=1 WHERE id=${revokedDevice}`,
      sql`INSERT INTO runbooks(id,name,description,created_at,created_by,customer_id,archived) VALUES('rb-x','Archiv','',${at},'fixture',${customerX},1)`,
      sql`INSERT INTO automation_templates(id,kind,slot,name,payload,created_by,created_at,customer_id,archived) VALUES('tpl-x','desired','default','Archiv','{}','fixture',${at},${customerX},1)`,
      sql`INSERT INTO notification_events(id,customer_id,kind,occurred_at,status) VALUES('ev-x',${customerX},'test',${at},'pending')`,
    ];
    for (const step of history) await database.exec(step);
    // The configuration of X, and the same kind of rows of customer B, which stay.
    const configuration = [
      sql`INSERT INTO customer_assignments(customer_id,principal_type,principal_id,created_at,created_by) VALUES(${customerX},'user',${ids.user},${at},'fixture'),(${ids.b},'user',${ids.user},${at},'fixture')`,
      sql`INSERT INTO customer_installers(id,customer_id,name,key_hash,mode,expires_at,created_at,created_by) VALUES('inst-x',${customerX},'Rollout','key-x','ReadOnly',${at + 86_400_000},${at},'fixture'),('inst-b',${ids.b},'Rollout','key-b','ReadOnly',${at + 86_400_000},${at},'fixture')`,
      sql`INSERT INTO assistant_keys(id,scope,customer_id,provider,model,secret,key_hint,updated_at,updated_by) VALUES('key-x','customer',${customerX},'openai','gpt','secret','abcd',${at},'fixture'),('key-b','customer',${ids.b},'openai','gpt','secret','abcd',${at},'fixture')`,
      sql`INSERT INTO notification_channels(id,type,name,enabled,config,target_hint,revision,created_at,created_by,updated_at,updated_by) VALUES('ch-x','webhook','Hook',1,'{}','',0,${at},'fixture',${at},'fixture')`,
      sql`INSERT INTO notification_rules(id,scope_type,scope_id,channel_id,levels,on_open,on_close,on_escalate,enabled,revision,created_at,created_by,updated_at,updated_by) VALUES('nr-x','customer',${customerX},'ch-x','["critical"]',1,0,0,1,0,${at},'fixture',${at},'fixture'),('nr-b','customer',${ids.b},'ch-x','["critical"]',1,0,0,1,0,${at},'fixture',${at},'fixture')`,
      sql`INSERT INTO alert_rule_overrides(id,rule_id,scope_type,scope_id,enabled,actor,updated_at) VALUES('aro-x','cpu','customer',${customerX},1,'fixture',${at}),('aro-b','cpu','customer',${ids.b},1,'fixture',${at})`,
      sql`INSERT INTO os_esu_overrides(id,scope_type,scope_id,until,actor,updated_at) VALUES('esu-x','customer',${customerX},'2030-01-01','fixture',${at}),('esu-b','customer',${ids.b},'2030-01-01','fixture',${at})`,
    ];
    for (const step of configuration) await database.exec(step);
    const kept = async () => ({
      audit: await database.query(sql`SELECT id,customer_id,action FROM audit WHERE id=9401`),
      device: await database.query(sql`SELECT id,customer_id,revoked FROM servers WHERE id=${revokedDevice}`),
      runbook: await database.query(sql`SELECT id,customer_id,archived FROM runbooks WHERE id='rb-x'`),
      template: await database.query(sql`SELECT id,customer_id,archived FROM automation_templates WHERE id='tpl-x'`),
      event: await database.query(sql`SELECT id,customer_id FROM notification_events WHERE id='ev-x'`),
    });
    const before = await kept();
    await database.exec(sql`DELETE FROM customers WHERE id=${customerX}`);
    assert.deepEqual(await kept(), before, 'audit, revoked device, archived runbook and template and the notification event keep the customer id');
    assert.equal(before.audit[0].customer_id, customerX);
    assert.deepEqual(await removedRow(database, customerX), [{ id: customerX, name: 'Kunde X' }], 'the tombstone has the last name');
    const left = async (table, column) => (await database.query(sql`SELECT ${sql.ident(column)} AS owner FROM ${sql.ident(table)} WHERE ${sql.ident(column)} IN (${customerX},${ids.b}) ORDER BY 1`)).map(row => row.owner);
    for (const [table, column] of [['customer_assignments', 'customer_id'], ['customer_installers', 'customer_id'], ['assistant_keys', 'customer_id'], ['notification_rules', 'scope_id'], ['alert_rule_overrides', 'scope_id'], ['os_esu_overrides', 'scope_id']]) {
      assert.deepEqual(await left(table, column), [ids.b], table + ': the rows of the deleted customer are gone, those of customer B stay');
    }
  });
});

test('the delete is refused while live data holds the customer, and for the default customer', async () => {
  await migratedDatabase(async database => {
    const holders = [
      ['an active device', sql`INSERT INTO servers(id,name,token_hash,created_at,customer_id) VALUES(${randomUUID()},'Gerät','token-live',${at},${customerX})`],
      ['a device group', sql`INSERT INTO device_groups(id,name,created_at,customer_id) VALUES(${randomUUID()},'Gruppe X',${at},${customerX})`],
      ['an active runbook', sql`INSERT INTO runbooks(id,name,description,created_at,created_by,customer_id) VALUES('rb-live','Live','',${at},'fixture',${customerX})`],
      ['an active template', sql`INSERT INTO automation_templates(id,kind,slot,name,payload,created_by,created_at,customer_id) VALUES('tpl-live','desired','default','Live','{}','fixture',${at},${customerX})`],
      ['a role', sql`INSERT INTO rbac_roles(id,name,permissions,created_at,customer_id) VALUES('role-live','Live','["view"]',${at},${customerX})`],
    ];
    for (const [label, holder] of holders) {
      const failure = await attempt(database, [insertX, holder], sql`DELETE FROM customers WHERE id=${customerX}`);
      assert.deepEqual([failure?.code, failure?.message], ['P0001', 'customer-in-use'], label);
    }
    const control = await attempt(database, [insertX], sql`DELETE FROM customers WHERE id=${customerX}`);
    assert.equal(control, null, 'without them the delete passes');
    const first = await attempt(database, [], sql`DELETE FROM customers WHERE id=${firstCustomer}`);
    assert.deepEqual([first?.code, first?.message], ['P0001', 'customer-default-protected'], 'the default customer');
  });
});

test('removed_customers is append-only and a removed id never names a customer again', async () => {
  await migratedDatabase(async database => {
    await database.exec(multipleCustomersOn);
    await database.exec(insertX);
    await database.exec(sql`DELETE FROM customers WHERE id=${customerX}`);
    await assert.rejects(database.exec(sql`UPDATE removed_customers SET name='Anders' WHERE id=${customerX}`), raised('removed-customer-immutable'), 'no update');
    await assert.rejects(database.exec(sql`DELETE FROM removed_customers WHERE id=${customerX}`), raised('removed-customer-immutable'), 'no delete');
    await assert.rejects(database.exec(insertX), raised('customer-id-removed'), 'no new customer with a removed id');
    const other = randomUUID();
    await database.exec(sql`INSERT INTO customers(id,name,created_at,updated_at) VALUES(${other},'Kunde Y',${at},${at})`);
    await assert.rejects(database.exec(sql`UPDATE customers SET id=${customerX} WHERE id=${other}`), raised('customer-id-removed'), 'no id change to a removed id');
    assert.deepEqual(await removedRow(database, customerX), [{ id: customerX, name: 'Kunde X' }], 'the tombstone is unchanged');
  });
});

test('a customer delete and a device insert into that customer cannot both commit', async () => {
  await migratedDatabase(async database => {
    await database.exec(multipleCustomersOn);
    const device = id => sql`INSERT INTO servers(id,name,token_hash,created_at,customer_id) VALUES(${id},'Rennen',${'token-' + id},${at},${customerX})`;
    const remove = sql`DELETE FROM customers WHERE id=${customerX}`;
    // The first statement runs in an open transaction; the second starts while it holds; then the first commits.
    // Each side answers null (committed) or its error after the retries of runtime/database.mjs.
    async function race(first, second) {
      let started, release;
      const holding = new Promise(resolve => { started = resolve; }), held = new Promise(resolve => { release = resolve; });
      const transaction = database.transaction(async tx => { await tx.exec(first); started(); await held; }).then(() => null, error => error);
      await holding;
      const result = database.exec(second).then(() => null, error => error);
      await new Promise(resolve => setTimeout(resolve, 300));
      release();
      return [await transaction, await result];
    }
    for (const order of ['delete first', 'insert first']) {
      await database.exec(sql`ALTER TABLE customers DISABLE TRIGGER customers_insert_removed_id`);
      await database.exec(sql`ALTER TABLE removed_customers DISABLE TRIGGER removed_customers_delete`);
      await database.exec(sql`DELETE FROM removed_customers WHERE id=${customerX}`);
      await database.exec(insertX);
      await database.exec(sql`ALTER TABLE customers ENABLE TRIGGER customers_insert_removed_id`);
      await database.exec(sql`ALTER TABLE removed_customers ENABLE TRIGGER removed_customers_delete`);
      const id = randomUUID();
      const outcome = order === 'delete first' ? await race(remove, device(id)) : await race(device(id), remove);
      const failed = outcome.filter(Boolean);
      assert.equal(failed.length, 1, `${order}: exactly one side commits (${outcome.map(entry => entry?.message ?? 'committed').join(', ')})`);
      assert.ok(['customer-missing', 'customer-in-use'].includes(failed[0].message), `${order}: the loser names the reason: ${failed[0].message}`);
      const customers = (await database.one(sql`SELECT count(*) AS n FROM customers WHERE id=${customerX}`)).n, devices = (await database.one(sql`SELECT count(*) AS n FROM servers WHERE id=${id}`)).n;
      assert.deepEqual([customers, devices], failed[0].message === 'customer-in-use' ? [1, 1] : [0, 0], `${order}: the customer and its device exist together or not at all`);
      if (customers) {
        await database.exec(sql`DELETE FROM servers WHERE id=${id}`);
        await database.exec(remove);
      }
    }
  });
});

test('customers_settings_valid accepts the bounds and refuses one step beyond them', async () => {
  const window = (days, start, duration, zone) => sql`maintenance_days=${days},maintenance_start=${start},maintenance_duration=${duration},maintenance_time_zone=${zone}`;
  const valid = [
    sql`audit_retention_days=1`, sql`audit_retention_days=3650`, sql`audit_retention_days=NULL`,
    window(1, 0, 15, 'U'), window(127, 1425, 720, 'x'.repeat(64)), window(65, 60, 240, 'Europe/Berlin'),
    sql`maintenance_days=NULL,maintenance_start=NULL,maintenance_duration=NULL,maintenance_time_zone=NULL`, sql`revision=0`,
  ];
  const invalid = [
    sql`audit_retention_days=0`, sql`audit_retention_days=3651`,
    window(0, 0, 15, 'UTC'), window(128, 0, 15, 'UTC'), window(1, -15, 15, 'UTC'), window(1, 1440, 15, 'UTC'), window(1, 10, 15, 'UTC'),
    window(1, 0, 0, 'UTC'), window(1, 0, 735, 'UTC'), window(1, 0, 20, 'UTC'), window(1, 0, 15, ''), window(1, 0, 15, 'x'.repeat(65)),
    sql`maintenance_days=1`, sql`maintenance_days=1,maintenance_start=0,maintenance_duration=15`, sql`revision=-1`,
  ];
  await migratedDatabase(async database => {
    for (const set of valid) await database.exec(sql`UPDATE customers SET ${set} WHERE id=${firstCustomer}`);
    for (const set of invalid) {
      await assert.rejects(database.exec(sql`UPDATE customers SET ${set} WHERE id=${firstCustomer}`), error => error.code === '23514' && error.constraint_name === 'customers_settings_valid', JSON.stringify(set));
    }
    await database.exec(multipleCustomersOn);
    const insert = (extra) => database.exec(sql`INSERT INTO customers(id,name,created_at,updated_at,audit_retention_days,maintenance_days,maintenance_start,maintenance_duration,maintenance_time_zone) VALUES(${randomUUID()},${'Neu ' + randomUUID()},${at},${at},${extra[0]},${extra[1]},${extra[2]},${extra[3]},${extra[4]})`);
    await insert([1, 127, 1425, 720, 'x'.repeat(64)]);
    await insert([3650, 1, 0, 15, 'U']);
    for (const values of [[0, null, null, null, null], [3651, null, null, null, null], [null, 3, null, null, null], [null, 1, 0, 15, '']]) {
      await assert.rejects(insert(values), error => error.code === '23514' && error.constraint_name === 'customers_settings_valid', JSON.stringify(values));
    }
  });
});

// 0027_entra_directory_check.sql on a database that already has Entra settings
// and an Entra account: the rows stay valid, the new column is NULL, the
// replaced test result CHECK takes the two Graph codes, and the new single row
// keeps its CHECKs.
const directoryCheckMigration = '0027_entra_directory_check.sql';
test('the Entra account check migration keeps existing rows valid and adds its CHECKs', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'serverdesk-entra-check-'));
  const database = await testDatabase({ template: false });
  try {
    const names = await migrationNames();
    assert.ok(names.includes(directoryCheckMigration), `${directoryCheckMigration} is shipped`);
    const earlier = names.filter(name => name < directoryCheckMigration);
    for (const name of earlier) await copyFile(path.join(directory, name), path.join(temporary, name));
    await migrateDatabase(database, { directory: temporary });
    const tenant = '11111111-2222-4333-8444-555555555555', object = '99999999-8888-4777-8666-555555555555';
    await database.exec(sql`INSERT INTO entra_settings(id,enabled,tenant_id,client_id,credential_kind,secret_enc,revision,tested_revision,tested_at,test_result) VALUES(1,1,${tenant},'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee','secret','ciphertext',3,3,${at},'ok')`);
    await database.exec(sql`INSERT INTO local_users(id,username,email,display_name,auth_principal,auth_email,status,password_hash,auth_version,must_reset,created_at,updated_at,identity_source,entra_tenant_id,entra_object_id)
      VALUES('entra-user','entra.user','','Entra',${`entra:${tenant}:${object}`},${`${object}@${tenant}.entra.serverdesk.invalid`},'active',NULL,1,0,${at},${at},'entra',${tenant},${object})`);
    await copyFile(path.join(directory, directoryCheckMigration), path.join(temporary, directoryCheckMigration));
    assert.deepEqual(await migrateDatabase(database, { directory: temporary }), { applied: 1, total: earlier.length + 1 });
    assert.deepEqual(await database.one(sql`SELECT enabled,test_result,revision FROM entra_settings`), { enabled: 1, test_result: 'ok', revision: 3 }, 'the settings row stays');
    assert.deepEqual(await database.one(sql`SELECT status,entra_checked_at FROM local_users WHERE id='entra-user'`), { status: 'active', entra_checked_at: null }, 'existing accounts were never checked');
    assert.deepEqual(await database.query(sql`SELECT id,last_started_at,last_result FROM entra_directory_check`), [{ id: 1, last_started_at: null, last_result: null }], 'the seed row');
    const refused = async (statement, constraint) => assert.rejects(database.exec(statement), error => error.code === '23514' && error.constraint_name === constraint, constraint);
    for (const code of ['graphPermissionMissing', 'graphUnreachable', 'unreachable', 'ok']) await database.exec(sql`UPDATE entra_settings SET test_result=${code}`);
    await refused(sql`UPDATE entra_settings SET test_result='permissionMissing'`, 'entra_settings_test_result');
    for (const code of ['ok', 'permissionMissing', 'credentialRefused', 'secretExpired', 'certificateRefused', 'unavailable', null]) await database.exec(sql`UPDATE entra_directory_check SET last_result=${code}`);
    await refused(sql`UPDATE entra_directory_check SET last_result='graphUnreachable'`, 'entra_directory_check_result');
    for (const column of ['checked_count', 'locked_count', 'group_change_count', 'remaining_count']) await refused(sql`UPDATE entra_directory_check SET ${sql.ident(column)}=-1`, 'entra_directory_check_counts');
    await refused(sql`INSERT INTO entra_directory_check(id) VALUES(2)`, 'entra_directory_check_single_row');
  } finally {
    await database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

// The kept last Owner marker (<n>_entra_kept_owner.sql) on a database with an
// Entra and a local account: the new column local_users.entra_kept_owner_since
// exists and reads NULL for both, and the accounts stay as they were.
test('the kept last Owner migration adds a NULL marker to existing accounts', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'serverdesk-entra-kept-'));
  const database = await testDatabase({ template: false });
  try {
    const names = await migrationNames(), keptOwnerMigration = names.find(name => name.endsWith('_entra_kept_owner.sql'));
    assert.ok(keptOwnerMigration, 'the kept last Owner migration is shipped');
    const earlier = names.filter(name => name < keptOwnerMigration);
    for (const name of earlier) await copyFile(path.join(directory, name), path.join(temporary, name));
    await migrateDatabase(database, { directory: temporary });
    const tenant = '11111111-2222-4333-8444-555555555555', object = '99999999-8888-4777-8666-555555555555';
    await database.exec(sql`INSERT INTO local_users(id,username,email,display_name,auth_principal,auth_email,status,password_hash,auth_version,must_reset,created_at,updated_at,identity_source,entra_tenant_id,entra_object_id,entra_checked_at)
      VALUES('entra-user','entra.user','','Entra',${`entra:${tenant}:${object}`},${`${object}@${tenant}.entra.serverdesk.invalid`},'active',NULL,1,0,${at},${at},'entra',${tenant},${object},${at})`);
    await database.exec(sql`INSERT INTO local_users(id,username,email,display_name,auth_principal,auth_email,status,password_hash,auth_version,must_reset,created_at,updated_at)
      VALUES('local-user','local.user','','Local','local:local@test','local@test','active','hash',1,0,${at},${at})`);
    await copyFile(path.join(directory, keptOwnerMigration), path.join(temporary, keptOwnerMigration));
    assert.deepEqual(await migrateDatabase(database, { directory: temporary }), { applied: 1, total: earlier.length + 1 });
    assert.deepEqual(await database.one(sql`SELECT data_type,is_nullable FROM information_schema.columns WHERE table_name='local_users' AND column_name='entra_kept_owner_since'`), { data_type: 'bigint', is_nullable: 'YES' }, 'a nullable bigint column');
    assert.deepEqual(await database.query(sql`SELECT id,status,entra_checked_at,entra_kept_owner_since FROM local_users ORDER BY id`), [
      { id: 'entra-user', status: 'active', entra_checked_at: at, entra_kept_owner_since: null },
      { id: 'local-user', status: 'active', entra_checked_at: null, entra_kept_owner_since: null },
    ], 'existing accounts read NULL and stay as they were');
  } finally {
    await database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

// 0028_entra_only.sql on a database with Entra settings, notification events
// and a delivery: the rows stay valid, Microsoft sign-in only starts off with no
// emergency access, the security alarm table starts empty, and the new CHECKs
// hold (no switch without an emergency access, no emergency event without its
// alarm, emergency events are critical and name no alarm of a device).
const entraOnlyMigration = '0028_entra_only.sql';
test('the Microsoft sign-in only migration keeps existing rows valid and adds its CHECKs', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'serverdesk-entra-only-'));
  const database = await testDatabase({ template: false });
  try {
    const names = await migrationNames();
    assert.ok(names.includes(entraOnlyMigration), `${entraOnlyMigration} is shipped`);
    const earlier = names.filter(name => name < entraOnlyMigration);
    for (const name of earlier) await copyFile(path.join(directory, name), path.join(temporary, name));
    await migrateDatabase(database, { directory: temporary });
    await database.exec(sql`INSERT INTO entra_settings(id,enabled,tenant_id,client_id,credential_kind,secret_enc,revision,tested_revision,tested_at,test_result) VALUES(1,1,'11111111-2222-4333-8444-555555555555','aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee','secret','ciphertext',3,3,${at},'ok')`);
    await database.exec(sql`INSERT INTO local_users(id,username,email,display_name,auth_principal,auth_email,status,password_hash,auth_version,must_reset,created_at,updated_at) VALUES('break-glass','break.glass','break@example.test','Break Glass','local:break-glass','break@example.test','active','hash',1,0,${at},${at})`);
    await database.exec(sql`INSERT INTO notification_events(id,alert_id,server_id,kind,level,rule_id,key,value,threshold,occurred_at,status) VALUES('event-open','alert-1','device-1','open','critical','cpu','cpu',97,90,${at},'routed')`);
    await database.exec(sql`INSERT INTO notification_events(id,kind,occurred_at,status,suppressed_reason) VALUES('event-test','test',${at},'suppressed','no-rule')`);
    await database.exec(sql`INSERT INTO notification_deliveries(id,event_id,channel_id,channel_name,channel_type,target_hint,status,attempts,created_at) VALUES('delivery-1','event-open',NULL,'Ops','webhook','x','pending',0,${at})`);
    await copyFile(path.join(directory, entraOnlyMigration), path.join(temporary, entraOnlyMigration));
    assert.deepEqual(await migrateDatabase(database, { directory: temporary }), { applied: 1, total: earlier.length + 1 });
    assert.deepEqual(await database.one(sql`SELECT enabled,revision,entra_only,emergency_user_id,entra_only_at,entra_only_by FROM entra_settings`), { enabled: 1, revision: 3, entra_only: 0, emergency_user_id: null, entra_only_at: null, entra_only_by: null }, 'Microsoft sign-in only starts off without an emergency access');
    assert.deepEqual(await database.query(sql`SELECT id,kind,security_alarm_id FROM notification_events ORDER BY id`), [{ id: 'event-open', kind: 'open', security_alarm_id: null }, { id: 'event-test', kind: 'test', security_alarm_id: null }], 'existing events stay valid');
    assert.deepEqual(await database.query(sql`SELECT id,recipients FROM notification_deliveries`), [{ id: 'delivery-1', recipients: null }], 'existing deliveries use the channel recipients');
    assert.deepEqual(await database.query(sql`SELECT * FROM security_alarms`), [], 'no alarm yet');
    const refused = async (statement, constraint) => assert.rejects(database.exec(statement), error => error.code === '23514' && error.constraint_name === constraint, constraint);
    await refused(sql`UPDATE entra_settings SET entra_only=1`, 'entra_settings_emergency');
    await database.exec(sql`UPDATE entra_settings SET emergency_user_id='break-glass'`);
    await refused(sql`UPDATE entra_settings SET entra_only=2`, 'entra_settings_entra_only');
    await database.exec(sql`UPDATE entra_settings SET entra_only=1,entra_only_at=${at},entra_only_by='owner@example.test'`);
    await assert.rejects(database.exec(sql`UPDATE entra_settings SET emergency_user_id='nobody'`), error => error.code === '23503', 'the emergency access is a local_users row');
    const alarm = (id, changes = sql``) => sql`INSERT INTO security_alarms(id,kind,user_id,actor,display_name,address,occurred_at${changes}) VALUES(${id},'emergencySignIn','break-glass','break@example.test','Break Glass','203.0.113.9',${at}`;
    await database.exec(sql`${alarm('alarm-1')})`);
    await refused(sql`INSERT INTO security_alarms(id,kind,user_id,actor,display_name,address,occurred_at) VALUES('alarm-x','failedSignIn','break-glass','a','b','c',${at})`, 'security_alarms_kind');
    await refused(sql`${alarm('alarm-y', sql`,acknowledged_at`)},${at})`, 'security_alarms_acknowledged');
    await refused(sql`UPDATE security_alarms SET acknowledged_by='owner@example.test'`, 'security_alarms_acknowledged');
    await database.exec(sql`UPDATE security_alarms SET acknowledged_at=${at},acknowledged_by='owner@example.test'`);
    const list = parts => parts.reduce((joined, part) => sql`${joined},${part}`);
    const event = (id, row) => sql`INSERT INTO notification_events(${list(['id', 'occurred_at', 'status', ...Object.keys(row)].map(sql.ident))}) VALUES(${list([id, at, 'pending', ...Object.values(row)].map(value => sql`${value}`))})`;
    await refused(event('event-x', { kind: 'emergency', level: 'critical' }), 'notification_events_emergency_check');
    await refused(event('event-x', { kind: 'open', level: 'critical', alert_id: 'alert-2', server_id: 'device-1', rule_id: 'cpu', key: 'cpu', security_alarm_id: 'alarm-1' }), 'notification_events_emergency_check');
    await refused(event('event-x', { kind: 'emergency', level: 'warning', security_alarm_id: 'alarm-1' }), 'notification_events_alarm_check');
    await refused(event('event-x', { kind: 'emergency', level: 'critical', security_alarm_id: 'alarm-1', alert_id: 'alert-3', server_id: 'device-1' }), 'notification_events_alarm_check');
    await database.exec(event('event-emergency', { kind: 'emergency', level: 'critical', security_alarm_id: 'alarm-1' }));
    await assert.rejects(database.exec(event('event-twice', { kind: 'emergency', level: 'critical', security_alarm_id: 'alarm-1' })), error => error.code === '23505' && error.constraint_name === 'idx_notification_events_security_alarm', 'one event per alarm');
    await database.exec(sql`UPDATE notification_events SET status='suppressed',suppressed_reason='no-recipient' WHERE id='event-emergency'`);
    await refused(sql`UPDATE notification_events SET suppressed_reason='nobody' WHERE id='event-emergency'`, 'notification_events_suppressed_check');
    await database.exec(sql`UPDATE notification_deliveries SET recipients='["owner@example.test"]'`);
    await refused(sql`UPDATE notification_deliveries SET recipients='{"to":"owner@example.test"}'`, 'notification_deliveries_recipients_check');
  } finally {
    await database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

// 0029_parallel_jobs.sql on a database with running and finished jobs: the
// rows stay, both new columns are NULL (every claim guard reads that as sole),
// and the CHECK takes exactly the three classes.
const parallelJobsMigration = '0029_parallel_jobs.sql';
test('the parallel jobs migration keeps running jobs and adds the class CHECK', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'serverdesk-parallel-jobs-'));
  const database = await testDatabase({ template: false });
  try {
    const names = await migrationNames();
    assert.ok(names.includes(parallelJobsMigration), `${parallelJobsMigration} is shipped`);
    const earlier = names.filter(name => name < parallelJobsMigration);
    for (const name of earlier) await copyFile(path.join(directory, name), path.join(temporary, name));
    await migrateDatabase(database, { directory: temporary });
    const server = randomUUID(), running = randomUUID(), done = randomUUID();
    await database.exec(sql`INSERT INTO jobs(id,server_id,action,target,state,created_at,claimed_at,actor,last_progress) VALUES(${running},${server},'install-updates','',${'running'},${at},${at},'fixture',${at}),(${done},${server},'refresh','',${'succeeded'},${at},${at},'fixture',${at})`);
    await copyFile(path.join(directory, parallelJobsMigration), path.join(temporary, parallelJobsMigration));
    assert.deepEqual(await migrateDatabase(database, { directory: temporary }), { applied: 1, total: earlier.length + 1 });
    assert.deepEqual(await database.query(sql`SELECT id,state,concurrency,concurrency_group FROM jobs ORDER BY state`), [
      { id: running, state: 'running', concurrency: null, concurrency_group: null },
      { id: done, state: 'succeeded', concurrency: null, concurrency_group: null },
    ], 'the jobs stay and have no class yet');
    for (const mode of ['parallel', 'exclusive', 'sole', null]) await database.exec(sql`UPDATE jobs SET concurrency=${mode} WHERE id=${running}`);
    await assert.rejects(database.exec(sql`UPDATE jobs SET concurrency='other' WHERE id=${running}`), error => error.code === '23514' && error.constraint_name === 'jobs_concurrency');
  } finally {
    await database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test('the named constraints and indexes of the old schema keep their names', async () => {
  await migratedDatabase(async database => {
    const names = new Set((await database.query(sql`SELECT conname AS name FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public'
      UNION SELECT indexname FROM pg_indexes WHERE schemaname='public'`)).map(row => row.name));
    for (const name of ['customer_installers_enrollments', 'idx_device_group_members_server', 'local_users_username', 'customers_name', 'customers_settings_valid', 'passkey_credentials_pkey', 'audit_scope'])
      assert.ok(names.has(name), name);
    assert.match((await database.one(sql`SELECT indexdef FROM pg_indexes WHERE indexname='customers_name'`)).indexdef, /UNIQUE INDEX customers_name ON public\.customers USING btree \(lower\(name\)\)/, 'customers_name is unique on lower(name)');
  });
});

test('drizzle-kit generate on a copy of drizzle/ writes no new migration', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'serverdesk-generate-'));
  try {
    await cp(directory, path.join(temporary, 'drizzle'), { recursive: true });
    const config = path.join(temporary, 'drizzle.config.mjs');
    await writeFile(config, `export default { out: './drizzle', schema: ${JSON.stringify(path.join(root, 'db/schema.ts').replaceAll('\\', '/'))}, dialect: 'postgresql' };\n`);
    const before = (await readdir(path.join(temporary, 'drizzle'), { recursive: true })).sort();
    const bin = path.join(root, 'node_modules', 'drizzle-kit', 'bin.cjs');
    // drizzle-kit resolves out against the working directory.
    const run = spawnSync(process.execPath, [bin, 'generate', '--config', config], { cwd: temporary, encoding: 'utf8', timeout: 120_000 });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout + run.stderr, /No schema changes, nothing to migrate/);
    assert.deepEqual((await readdir(path.join(temporary, 'drizzle'), { recursive: true })).sort(), before, 'no file is added');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

// The hosting leftovers stay removed in the baseline. Built from parts, so the
// scan for removed names (tests/repo/legacy-cleanup.mjs) skips this file.
const removedTables = [['chatgpt', 'roles'], ['portal', 'memberships'], ['device', 'grants'], ['release', 'uploads'], ['release', 'upload', 'chunks']].map(parts => parts.join('_'));
test('the baseline has no hosting leftovers and keeps the four audit triggers', async () => {
  await migratedDatabase(async database => {
    for (const table of removedTables) assert.equal(await exists(database, table), false, `${table} is gone`);
    const has = async (table, column) => !!await database.one(sql`SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=${table} AND column_name=${column}`);
    assert.equal(await has('servers', ['legacy', 'token', 'expires', 'at'].join('_')), false, 'servers has no legacy token deadline');
    assert.equal(await has('local_users', ['legacy', 'role'].join('_')), false, 'local_users has no old role column');
    const userChecks = (await database.query(sql`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='local_users'::regclass`)).map(row => row.definition).join('\n');
    assert.doesNotMatch(userChecks, new RegExp(['legacy', 'role'].join('_')), 'the role CHECK is gone');
    await assert.rejects(database.exec(sql`INSERT INTO audit(at,actor,action,target,scope) VALUES(1,'a','b','c',${'legacy'})`), error => error.code === '23514' && error.constraint_name === 'audit_scope', "the scope 'legacy' is refused");
    assert.equal(await database.one(sql`SELECT value FROM identity_settings WHERE key='local_users_seeded_v1'`), null, 'no seed marker');
    assert.equal((await database.one(sql`SELECT count(*) AS n FROM pg_trigger WHERE tgrelid='audit'::regclass AND NOT tgisinternal`)).n, 4, 'the four audit triggers exist');
  });
});

test('offline bootstrap creates one invited Owner and stores only the token digest', async () => {
  await migratedDatabase(async database => {
    const before = Date.now();
    const result = await bootstrapOwner(database, { ...ownerOptions, username: 'Admin' });
    assert.equal(result.username, 'admin');
    const invitation = new URL(result.invitationUrl);
    assert.equal(invitation.origin, environment.SITE_ORIGIN);
    assert.equal(invitation.pathname, '/');
    assert.equal(invitation.search, '');
    const token = new URLSearchParams(invitation.hash.slice(1)).get('invite');
    assert.match(token, /^[a-f0-9]{64}$/);
    assert.ok(result.expiresAt >= before + 24 * 60 * 60_000);
    assert.ok(result.expiresAt <= Date.now() + 24 * 60 * 60_000);

    const user = await database.one(sql`SELECT * FROM local_users WHERE id=${result.userId}`);
    assert.equal(user.status, 'invited');
    assert.equal(user.password_hash, null);
    assert.equal(user.auth_version, 1);
    assert.equal(user.auth_principal, 'private:' + user.auth_email);
    assert.notEqual(user.auth_email, user.email, 'internal identity remains separate from mutable contact email');
    const stored = await database.one(sql`SELECT * FROM local_account_tokens WHERE user_id=${result.userId}`);
    assert.equal(stored.kind, 'invite');
    assert.equal(stored.token_hash, createHash('sha256').update(token).digest('hex'));
    assert.notEqual(stored.token_hash, token);
    assert.equal(stored.used_at, null);
    assert.equal(stored.auth_version, user.auth_version);
    assert.equal(stored.expires_at, result.expiresAt);
    const assignment = await database.one(sql`SELECT * FROM role_assignments WHERE principal_id=${result.userId}`);
    assert.equal(assignment.principal_type, 'user');
    assert.equal(assignment.role_id, 'builtin-owner');
    assert.equal(assignment.scope_type, 'global');
    assert.equal(assignment.scope_id, '*');
    const role = await database.one(sql`SELECT * FROM rbac_roles WHERE id='builtin-owner'`);
    assert.deepEqual(JSON.parse(role.permissions), ['*']);
    assert.equal(role.builtin, 1);
    assert.equal(await database.one(sql`SELECT value FROM identity_settings WHERE key='local_users_seeded_v1'`), null, 'bootstrap writes no seed marker');
    assert.equal(await database.one(sql`SELECT value FROM identity_settings WHERE key='rbac_migrated_v1'`), null, 'the application seeds the remaining built-in roles');
    assert.equal(await database.one(sql`SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='local_users' AND column_name=${['legacy', 'role'].join('_')}`), null, 'local_users has no old role column');
    const audit = await database.one(sql`SELECT * FROM audit WHERE action='auth.owner.bootstrap'`);
    assert.equal(audit.target, result.userId);
    assert.equal(JSON.stringify(audit).includes(token), false, 'secret is absent from audit logs');

    await assert.rejects(bootstrapOwner(database, { ...ownerOptions, username: 'another' }), /Local users already exist/);
    assert.equal((await database.one(sql`SELECT count(*) AS count FROM local_users`)).count, 1);
    assert.equal((await database.one(sql`SELECT count(*) AS count FROM local_account_tokens`)).count, 1);
  });
});

test('concurrent initial bootstrap attempts commit exactly one Owner invitation', async () => {
  await migratedDatabase(async database => {
    const results = await Promise.allSettled([
      bootstrapOwner(database, { ...ownerOptions, username: 'first.owner' }),
      bootstrapOwner(database, { ...ownerOptions, username: 'second.owner' }),
    ]);
    const accepted = results.filter(result => result.status === 'fulfilled');
    const rejected = results.filter(result => result.status === 'rejected');
    assert.equal(accepted.length, 1);
    assert.equal(rejected.length, 1);
    const winner = accepted[0].value;
    assert.equal((await database.one(sql`SELECT count(*) AS count FROM local_users`)).count, 1);
    assert.equal((await database.one(sql`SELECT count(*) AS count FROM local_account_tokens`)).count, 1);
    assert.equal((await database.one(sql`SELECT count(*) AS count FROM role_assignments`)).count, 1);
    const marker = await database.one(sql`SELECT value FROM identity_settings WHERE key='selfhost_bootstrap_v1'`);
    assert.equal(marker.value, winner.userId);
    assert.equal((await database.one(sql`SELECT count(*) AS count FROM audit WHERE action='auth.owner.bootstrap'`)).count, 1);
  });
});

test('bootstrap requires a migrated database, safe origin and external secrets', async () => {
  await emptyDatabase(async database => {
    await assert.rejects(bootstrapOwner(database, ownerOptions), /Apply all migrations/);
    await migrateDatabase(database);
    for (const key of ['SESSION_SECRET', 'PASSWORD_PEPPER']) {
      await assert.rejects(bootstrapOwner(database, { ...ownerOptions, env: { ...environment, [key]: 'too short' } }), new RegExp(key));
    }
    for (const origin of ['http://nas.example.test', 'https://serverdesk.test/', 'https://serverdesk.test/path', 'https://user:secret@serverdesk.test']) {
      await assert.rejects(bootstrapOwner(database, { ...ownerOptions, origin }), /SITE_ORIGIN/);
    }
    await assert.rejects(bootstrapOwner(database, { ...ownerOptions, username: 'x' }), /Username/);
    await assert.rejects(bootstrapOwner(database, { ...ownerOptions, displayName: 'bad\nname' }), /display name/);
    assert.equal((await database.one(sql`SELECT count(*) AS count FROM local_users`)).count, 0, 'invalid configuration creates no account');
  });
});

// 0042_branding_assets.sql (docs/branding.md, "Storage"): the CHECK constraints
// and the unique index on (COALESCE(customer_id,''), slot).
test('branding_assets keeps one valid image per owner and slot', async () => {
  await migratedDatabase(async database => {
    assert.deepEqual(await database.query(sql`SELECT count(*)::int AS n FROM branding_assets`), [{ n: 0 }], 'the table exists and starts empty');
    await database.exec(multipleCustomersOn);
    const customer = randomUUID();
    await database.exec(sql`INSERT INTO customers(id,name,created_at,updated_at) VALUES(${customer},'Kunde Logo',${at},${at})`);
    const hex = size => '89'.repeat(size);
    const insert = ({ owner = null, slot = 'light', type = 'image/png', size = 4, stored = size, hash = 'a'.repeat(64), width = 32, height = 32 } = {}) => database.exec(sql`INSERT INTO branding_assets(customer_id,slot,content_type,data,size,width,height,sha256,updated_at,updated_by) VALUES(${owner},${slot},${type},decode(${hex(stored)},'hex'),${size},${width},${height},${hash},${at},'fixture')`);
    const refused = constraint => error => error.code === '23514' && error.constraint_name === constraint;
    await assert.rejects(insert({ owner: customer, slot: 'icon' }), refused('branding_assets_icon_portal'), 'no icon for a customer');
    await assert.rejects(insert({ owner: firstCustomer }), refused('branding_assets_not_default_customer'), 'no logo for the default customer');
    await assert.rejects(insert({ size: 5, stored: 4 }), refused('branding_assets_size'), 'size must equal the stored bytes');
    await assert.rejects(insert({ slot: 'icon', size: 262145 }), refused('branding_assets_size'), 'an icon over 256 KiB');
    await assert.rejects(insert({ size: 2097153 }), refused('branding_assets_size'), 'a logo over 2 MiB');
    await assert.rejects(insert({ type: 'image/gif' }), refused('branding_assets_content_type'), 'a bad type');
    await assert.rejects(insert({ slot: 'banner' }), refused('branding_assets_slot'), 'an unknown slot');
    await assert.rejects(insert({ width: 0 }), refused('branding_assets_dimensions'), 'a zero width');
    await assert.rejects(insert({ hash: 'A'.repeat(64) }), refused('branding_assets_sha256'), 'an upper-case hash');
    await assert.rejects(insert({ owner: randomUUID() }), error => error.code === '23503', 'an unknown customer');
    await insert();
    await insert({ owner: customer });
    await insert({ slot: 'icon', size: 262144 });
    await assert.rejects(insert(), error => error.code === '23505' && error.constraint_name === 'branding_assets_owner_slot', 'a second portal light logo');
    await assert.rejects(insert({ owner: customer }), error => error.code === '23505' && error.constraint_name === 'branding_assets_owner_slot', 'a second customer light logo');
    assert.deepEqual((await database.query(sql`SELECT customer_id,slot FROM branding_assets ORDER BY slot,customer_id NULLS FIRST`)).map(row => [row.customer_id, row.slot]), [[null, 'icon'], [null, 'light'], [customer, 'light']]);
  });
});

// 0043_branding_backgrounds.sql (docs/branding.md, "Storage"): the background slots in branding_assets with their
// size limit and the portal-only rule, branding_settings with one row at most, and account_preferences with its
// cascade; the logo and icon rows survive the migration unchanged.
test('branding backgrounds: the new slots and limits, branding_settings, account_preferences, and unchanged logo and icon rows', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'serverdesk-branding-backgrounds-'));
  const database = await testDatabase({ template: false });
  try {
    const names = await migrationNames(), migration = names.find(name => name.endsWith('_branding_backgrounds.sql'));
    assert.ok(migration, 'the migration of the backgrounds is shipped');
    const earlier = names.filter(name => name < migration);
    for (const name of earlier) await copyFile(path.join(directory, name), path.join(temporary, name));
    await migrateDatabase(database, { directory: temporary });
    await database.exec(multipleCustomersOn);
    const customer = randomUUID();
    await database.exec(sql`INSERT INTO customers(id,name,created_at,updated_at) VALUES(${customer},'Kunde Hintergrund',${at},${at})`);
    const hex = size => '89'.repeat(size);
    const insert = ({ owner = null, slot = 'light', size = 4 } = {}) => database.exec(sql`INSERT INTO branding_assets(customer_id,slot,content_type,data,size,width,height,sha256,updated_at,updated_by) VALUES(${owner},${slot},'image/png',decode(${hex(size)},'hex'),${size},${1920},${1080},${'a'.repeat(64)},${at},'fixture')`);
    await insert();
    await insert({ slot: 'icon', size: 262144 });
    await insert({ owner: customer, slot: 'dark', size: 2097152 });
    const assets = () => database.query(sql`SELECT customer_id,slot,content_type,size,width,height,sha256,updated_at,updated_by,encode(data,'hex') AS hex FROM branding_assets ORDER BY slot,customer_id NULLS FIRST`);
    const before = await assets();
    await copyFile(path.join(directory, migration), path.join(temporary, migration));
    assert.deepEqual(await migrateDatabase(database, { directory: temporary }), { applied: 1, total: earlier.length + 1 });
    assert.deepEqual(await assets(), before, 'the logo and icon rows are unchanged');
    assert.deepEqual(await database.query(sql`SELECT * FROM branding_settings`), [], 'no settings row is inserted');
    assert.deepEqual(await database.query(sql`SELECT * FROM account_preferences`), [], 'no preference row is inserted');

    const refused = constraint => error => error.code === '23514' && error.constraint_name === constraint;
    // Background slots: 8 MiB passes, one byte more fails; a logo over 2 MiB and an icon over 256 KiB still fail.
    await insert({ slot: 'signin', size: 8388608 });
    await assert.rejects(insert({ slot: 'console', size: 8388609 }), refused('branding_assets_size'), 'a background over 8 MiB');
    await insert({ slot: 'console', size: 1 });
    await assert.rejects(insert({ slot: 'light', size: 2097153 }), refused('branding_assets_size'), 'a logo over 2 MiB still fails');
    await assert.rejects(insert({ owner: customer, slot: 'light', size: 2097153 }), refused('branding_assets_size'), 'a customer logo over 2 MiB still fails');
    await assert.rejects(insert({ owner: customer, slot: 'signin' }), refused('branding_assets_background_portal'), 'no background for a customer');
    await assert.rejects(insert({ slot: 'banner' }), refused('branding_assets_slot'), 'an unknown slot');
    await assert.rejects(insert({ slot: 'console', size: 0 }), refused('branding_assets_size'), 'an empty file');

    // branding_settings: one row at most, known choices, lowercase #rrggbb, both colors or none.
    const settings = ({ id = 1, signin = 'none', console = 'none', primary = null, secondary = null } = {}) => database.exec(sql`INSERT INTO branding_settings(id,signin_background,console_background,scheme_primary,scheme_secondary,updated_at,updated_by) VALUES(${id},${signin},${console},${primary},${secondary},${at},'fixture')`);
    await assert.rejects(settings({ id: 2 }), refused('branding_settings_single'), 'a second id');
    await assert.rejects(settings({ signin: 'forest' }), refused('branding_settings_signin_background'), 'a bad sign-in choice');
    await assert.rejects(settings({ console: 'Upload' }), refused('branding_settings_console_background'), 'a bad console choice');
    await assert.rejects(settings({ primary: '#ABCDEF', secondary: '#000000' }), refused('branding_settings_scheme_primary'), 'an upper-case hex');
    await assert.rejects(settings({ primary: '#000000', secondary: 'red' }), refused('branding_settings_scheme_secondary'), 'a named color');
    await assert.rejects(settings({ primary: '#000000' }), refused('branding_settings_scheme_pair'), 'one scheme color alone');
    await settings({ signin: 'upload', console: 'bloom', primary: '#1e5adc', secondary: '#f07814' });
    await assert.rejects(settings(), error => error.code === '23505', 'one row at most');
    const columns = await database.query(sql`SELECT column_name,column_default FROM information_schema.columns WHERE table_name='branding_settings' AND column_name LIKE '%_background' ORDER BY column_name`);
    assert.deepEqual(columns.map(column => [column.column_name, column.column_default]), [['console_background', "'none'::text"], ['signin_background', "'none'::text"]], 'both choices default to none');

    // account_preferences: default on, the FK to local_users with a cascade.
    const user = randomUUID();
    await database.exec(sql`INSERT INTO local_users(id,username,email,display_name,auth_principal,auth_email,status,auth_version,created_at,updated_at) VALUES(${user},${user},'p@example.test','P',${'local:' + user},'p@example.test','active',1,${at},${at})`);
    await database.exec(sql`INSERT INTO account_preferences(user_id,updated_at) VALUES(${user},${at})`);
    assert.deepEqual(await database.query(sql`SELECT console_background FROM account_preferences`), [{ console_background: true }], 'on by default');
    await assert.rejects(database.exec(sql`INSERT INTO account_preferences(user_id,updated_at) VALUES(${randomUUID()},${at})`), error => error.code === '23503', 'an unknown account');
    await database.exec(sql`DELETE FROM local_users WHERE id=${user}`);
    assert.deepEqual(await database.query(sql`SELECT * FROM account_preferences`), [], 'deleting the account removes its row');
  } finally {
    await database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

// 0044_pinned_devices.sql (docs/device-workspace.md, "Pinned devices"): account_pinned_devices with the key
// (user_id, device_id), the index on device_id, the foreign keys to local_users and servers with their cascades,
// no inserted row; the rows of the 0043 tables survive the migration unchanged.
test('pinned devices: the table, its key, its foreign keys and cascades, and unchanged 0043 rows', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'serverdesk-pinned-devices-'));
  const database = await testDatabase({ template: false });
  try {
    const names = await migrationNames(), migration = names.find(name => name.endsWith('_pinned_devices.sql'));
    assert.ok(migration, 'the migration of the pinned devices is shipped');
    const earlier = names.filter(name => name < migration);
    for (const name of earlier) await copyFile(path.join(directory, name), path.join(temporary, name));
    await migrateDatabase(database, { directory: temporary });
    const user = randomUUID(), other = randomUUID(), device = randomUUID(), second = randomUUID();
    for (const id of [user, other]) await database.exec(sql`INSERT INTO local_users(id,username,email,display_name,auth_principal,auth_email,status,auth_version,created_at,updated_at) VALUES(${id},${id},${id + '@example.test'},'P',${'local:' + id},${id + '@example.test'},'active',1,${at},${at})`);
    for (const id of [device, second]) await database.exec(sql`INSERT INTO servers(id,name,token_hash,created_at) VALUES(${id},${'Server ' + id},${'fixture-' + id},${at})`);
    await database.exec(sql`INSERT INTO account_preferences(user_id,console_background,updated_at) VALUES(${user},false,${at})`);
    await database.exec(sql`INSERT INTO branding_settings(id,signin_background,console_background,updated_at,updated_by) VALUES(1,'mist','dusk',${at},'fixture')`);
    const kept = async () => [await database.query(sql`SELECT * FROM account_preferences`), await database.query(sql`SELECT * FROM branding_settings`)];
    const before = await kept();
    await copyFile(path.join(directory, migration), path.join(temporary, migration));
    assert.deepEqual(await migrateDatabase(database, { directory: temporary }), { applied: 1, total: earlier.length + 1 });
    assert.deepEqual(await kept(), before, 'the 0043 rows are unchanged');
    assert.deepEqual(await database.query(sql`SELECT * FROM account_pinned_devices`), [], 'no pin row is inserted');
    const indexes = await database.query(sql`SELECT indexname FROM pg_indexes WHERE tablename='account_pinned_devices' ORDER BY indexname`);
    assert.deepEqual(indexes.map(row => row.indexname), ['account_pinned_devices_user_id_device_id_pk', 'idx_account_pinned_devices_device'], 'the key and the device index');
    const triggers = await database.query(sql`SELECT tgname FROM pg_trigger WHERE tgrelid=to_regclass('public.account_pinned_devices') AND NOT tgisinternal`);
    assert.deepEqual(triggers, [], 'no trigger');

    const pin = (userId, deviceId) => database.exec(sql`INSERT INTO account_pinned_devices(user_id,device_id,created_at) VALUES(${userId},${deviceId},${at})`);
    await pin(user, device);
    await pin(user, second);
    await pin(other, device);
    await assert.rejects(pin(user, device), error => error.code === '23505', 'a duplicate key');
    await assert.rejects(pin(randomUUID(), device), error => error.code === '23503', 'an unknown account');
    await assert.rejects(pin(user, randomUUID()), error => error.code === '23503', 'an unknown device');
    const rows = () => database.query(sql`SELECT user_id,device_id FROM account_pinned_devices ORDER BY user_id,device_id`).then(list => list.map(row => [row.user_id, row.device_id].join(' ')));
    await database.exec(sql`DELETE FROM servers WHERE id=${device}`);
    assert.deepEqual(await rows(), [user + ' ' + second], 'deleting the device removes its pins');
    await database.exec(sql`DELETE FROM account_preferences WHERE user_id=${user}`);
    await database.exec(sql`DELETE FROM local_users WHERE id=${user}`);
    assert.deepEqual(await rows(), [], 'deleting the account removes its pins');
  } finally {
    await database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

// 0045_dashboard.sql (docs/dashboard.md, "Storage"): the nullable column account_preferences.dashboard_layout and the
// table dashboard_settings with its single row (CHECK id = 1); no inserted row, no trigger, and the rows of the 0043
// and 0044 tables survive the migration unchanged.
test('dashboard layouts: the column, the one-row table and unchanged 0044 rows', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'serverdesk-dashboard-'));
  const database = await testDatabase({ template: false });
  try {
    const names = await migrationNames(), migration = names.find(name => name.endsWith('_dashboard.sql'));
    assert.ok(migration, 'the migration of the Dashboard is shipped');
    assert.match(migration, /^0045_/, 'it is migration 0045');
    const earlier = names.filter(name => name < migration);
    for (const name of earlier) await copyFile(path.join(directory, name), path.join(temporary, name));
    await migrateDatabase(database, { directory: temporary });
    const user = randomUUID(), device = randomUUID();
    await database.exec(sql`INSERT INTO local_users(id,username,email,display_name,auth_principal,auth_email,status,auth_version,created_at,updated_at) VALUES(${user},${user},${user + '@example.test'},'D',${'local:' + user},${user + '@example.test'},'active',1,${at},${at})`);
    await database.exec(sql`INSERT INTO servers(id,name,token_hash,created_at) VALUES(${device},'Server D',${'fixture-' + device},${at})`);
    await database.exec(sql`INSERT INTO account_preferences(user_id,console_background,updated_at) VALUES(${user},false,${at})`);
    await database.exec(sql`INSERT INTO account_pinned_devices(user_id,device_id,created_at) VALUES(${user},${device},${at})`);
    const pins = () => database.query(sql`SELECT * FROM account_pinned_devices`);
    const before = [await database.query(sql`SELECT user_id,console_background,updated_at FROM account_preferences`), await pins()];
    await copyFile(path.join(directory, migration), path.join(temporary, migration));
    assert.deepEqual(await migrateDatabase(database, { directory: temporary }), { applied: 1, total: earlier.length + 1 });
    assert.deepEqual([await database.query(sql`SELECT user_id,console_background,updated_at FROM account_preferences`), await pins()], before, 'the 0043 and 0044 rows are unchanged');
    assert.deepEqual(await database.query(sql`SELECT dashboard_layout FROM account_preferences`), [{ dashboard_layout: null }], 'an existing account follows the default layout');
    const column = await database.one(sql`SELECT data_type,is_nullable,column_default FROM information_schema.columns WHERE table_name='account_preferences' AND column_name='dashboard_layout'`);
    assert.deepEqual(column, { data_type: 'text', is_nullable: 'YES', column_default: null }, 'the column is nullable text without a default');
    assert.deepEqual(await database.query(sql`SELECT * FROM dashboard_settings`), [], 'no default layout is inserted');
    const columns = await database.query(sql`SELECT column_name,data_type,is_nullable FROM information_schema.columns WHERE table_name='dashboard_settings' ORDER BY ordinal_position`);
    assert.deepEqual(columns.map(row => [row.column_name, row.data_type, row.is_nullable]), [['id', 'smallint', 'NO'], ['default_layout', 'text', 'NO'], ['updated_at', 'bigint', 'NO'], ['updated_by', 'text', 'NO']]);
    const triggers = await database.query(sql`SELECT tgname FROM pg_trigger WHERE tgrelid=to_regclass('public.dashboard_settings') AND NOT tgisinternal`);
    assert.deepEqual(triggers, [], 'no trigger');

    const store = id => database.exec(sql`INSERT INTO dashboard_settings(id,default_layout,updated_at,updated_by) VALUES(${id},'[]',${at},'fixture')`);
    await store(1);
    await assert.rejects(store(1), error => error.code === '23505', 'the row exists once');
    await assert.rejects(store(2), error => error.code === '23514', 'only the row with id 1');
    await assert.rejects(database.exec(sql`UPDATE dashboard_settings SET default_layout=NULL`), error => error.code === '23502', 'the layout is never NULL');
    await database.exec(sql`UPDATE account_preferences SET dashboard_layout='[]' WHERE user_id=${user}`);
    await database.exec(sql`DELETE FROM account_pinned_devices WHERE user_id=${user}`);
    await database.exec(sql`DELETE FROM local_users WHERE id=${user}`);
    assert.deepEqual(await database.query(sql`SELECT * FROM account_preferences`), [], 'deleting the account removes its layout');
    assert.equal((await database.query(sql`SELECT * FROM dashboard_settings`)).length, 1, 'the default layout belongs to no account');
  } finally {
    await database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

// 0046_dashboard_widgets.sql (docs/dashboard.md, "Storage"): a data migration without a schema change. Every stored
// layout of the first Dashboard (a bare JSON array of {id, shown}) becomes {version, widgets} with exactly the widgets,
// order and sizes that storedDashboardLayout (lib/dashboard-layout.ts) reads from the old text. A layout of the new
// form, NULL, unreadable text and JSON that is no array stay byte for byte, and no other column changes.
test('dashboard widgets: stored layouts of the first Dashboard are rewritten, every other row stays', async () => {
  await import('../support/register.mjs');
  const { storedDashboardLayout } = await import('../../lib/dashboard-layout.ts');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'serverdesk-dashboard-widgets-'));
  const database = await testDatabase({ template: false });
  try {
    const names = await migrationNames(), migration = names.find(name => name.endsWith('_dashboard_widgets.sql'));
    assert.ok(migration, 'the migration of the Dashboard widgets is shipped');
    assert.match(migration, /^0046_/, 'it is migration 0046');
    const earlier = names.filter(name => name < migration);
    for (const name of earlier) await copyFile(path.join(directory, name), path.join(temporary, name));
    await migrateDatabase(database, { directory: temporary });
    const former = (order, hidden = []) => JSON.stringify(order.map(id => ({ id, shown: !hidden.includes(id) })));
    const current = '{"version":2,"widgets":[{"id":"status","w":1,"h":1},{"id":"jobs","w":4,"h":3}]}';
    const layouts = {
      reordered: former(['jobs', 'alarm-week', 'alarms', 'updates', 'offline'], ['updates']),
      builtIn: former(['alarms', 'offline', 'updates', 'jobs', 'alarm-week']),
      allHidden: former(['alarms', 'offline', 'updates', 'jobs', 'alarm-week'], ['alarms', 'offline', 'updates', 'jobs', 'alarm-week']),
      missing: former(['offline', 'alarms'], ['alarms']),
      emptyArray: '[]',
      odd: JSON.stringify([{ id: 'alarms', shown: false }, { id: 'alarms', shown: true }, { id: 'weather', shown: true }, { id: 'jobs', shown: 'no' }, 7, null, ['x'], { id: 'updates', w: 4, h: 3 }]),
      spaced: ' [ { "id" : "jobs" , "shown" : true } ] ',
      current,
      emptyBoard: '{"version":2,"widgets":[]}',
      none: null,
      broken: '{broken',
      text: 'layout',
      number: '7',
      object: '{"id":"jobs","shown":true}',
    };
    const users = {};
    for (const [index, [key, layout]] of Object.entries(layouts).entries()) {
      const user = users[key] = randomUUID();
      await database.exec(sql`INSERT INTO local_users(id,username,email,display_name,auth_principal,auth_email,status,auth_version,created_at,updated_at) VALUES(${user},${user},${user + '@example.test'},'D',${'local:' + user},${user + '@example.test'},'active',1,${at},${at})`);
      await database.exec(sql`INSERT INTO account_preferences(user_id,console_background,dashboard_layout,updated_at) VALUES(${user},${index % 2 === 0},${layout}::text,${at + index})`);
    }
    await database.exec(sql`INSERT INTO dashboard_settings(id,default_layout,updated_at,updated_by) VALUES(1,${layouts.missing},${at},'fixture')`);
    const rows = async () => Object.fromEntries((await database.query(sql`SELECT user_id,console_background,dashboard_layout,updated_at FROM account_preferences`)).map(row => [row.user_id, row]));
    const before = await rows();
    await copyFile(path.join(directory, migration), path.join(temporary, migration));
    assert.deepEqual(await migrateDatabase(database, { directory: temporary }), { applied: 1, total: earlier.length + 1 });
    const after = await rows();
    const rewritten = ['reordered', 'builtIn', 'allHidden', 'missing', 'emptyArray', 'odd', 'spaced'], kept = Object.keys(layouts).filter(key => !rewritten.includes(key));
    for (const key of rewritten) {
      const stored = after[users[key]].dashboard_layout, parsed = JSON.parse(stored);
      assert.deepEqual([Object.keys(parsed), parsed.version, Array.isArray(parsed.widgets)], [['version', 'widgets'], 2, true], `${key}: the new stored form`);
      assert.deepEqual(parsed.widgets, storedDashboardLayout(layouts[key]), `${key}: the widgets, order and sizes that the reader gave for the old text`);
      assert.deepEqual(storedDashboardLayout(stored), storedDashboardLayout(layouts[key]), `${key}: the page shows the same layout as before`);
    }
    const ids = key => JSON.parse(after[users[key]].dashboard_layout).widgets.map(widget => `${widget.id}:${widget.w}x${widget.h}`);
    assert.deepEqual(ids('reordered'), ['jobs:2x2', 'alarm-week:2x2', 'alarms:2x2', 'offline:1x2'], 'the stored order stays, a hidden tile is not on the board, each tile has its default size');
    assert.deepEqual(ids('allHidden'), [], 'every tile hidden: an empty board');
    assert.deepEqual(ids('missing'), ['offline:1x2', 'updates:1x2', 'jobs:2x2', 'alarm-week:2x2'], 'a tile the layout did not name is appended; a hidden one stays off');
    assert.deepEqual(ids('odd'), ['jobs:2x2', 'updates:1x2', 'offline:1x2', 'alarm-week:2x2'], 'the first entry of a tile counts, only shown:false hides, unknown ids and non-objects are dropped');
    for (const key of kept) assert.equal(after[users[key]].dashboard_layout, layouts[key], `${key}: stays byte for byte`);
    for (const key of Object.keys(layouts)) assert.deepEqual([after[users[key]].console_background, after[users[key]].updated_at], [before[users[key]].console_background, before[users[key]].updated_at], `${key}: no other column changes`);
    const fallback = await database.one(sql`SELECT default_layout,updated_at,updated_by FROM dashboard_settings WHERE id=1`);
    assert.deepEqual([JSON.parse(fallback.default_layout).widgets, String(fallback.updated_at), fallback.updated_by], [storedDashboardLayout(layouts.missing), String(at), 'fixture'], 'the default layout is rewritten the same way; its other columns stay');
    const script = (await readFile(path.join(directory, migration), 'utf8')).replace(/^--.*$/gm, '');
    assert.equal(script.split('statement-breakpoint').length, 2, 'one statement per table');
    assert.doesNotMatch(script, /(CREATE|ALTER|DROP)/i, 'no schema change');
  } finally {
    await database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

// The same migration with a default layout that is no JSON: the migration succeeds and the row stays.
test('dashboard widgets: an unreadable default layout does not stop the migration', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'serverdesk-dashboard-widgets-'));
  const database = await testDatabase({ template: false });
  try {
    const names = await migrationNames(), migration = names.find(name => name.endsWith('_dashboard_widgets.sql'));
    const earlier = names.filter(name => name < migration);
    for (const name of earlier) await copyFile(path.join(directory, name), path.join(temporary, name));
    await migrateDatabase(database, { directory: temporary });
    await database.exec(sql`INSERT INTO dashboard_settings(id,default_layout,updated_at,updated_by) VALUES(1,'{broken',${at},'fixture')`);
    await copyFile(path.join(directory, migration), path.join(temporary, migration));
    assert.deepEqual(await migrateDatabase(database, { directory: temporary }), { applied: 1, total: earlier.length + 1 });
    assert.deepEqual(await database.query(sql`SELECT default_layout,updated_by FROM dashboard_settings`), [{ default_layout: '{broken', updated_by: 'fixture' }]);
    assert.deepEqual(await migrateDatabase(database, { directory: temporary }), { applied: 0, total: earlier.length + 1 }, 'a second run applies nothing');
  } finally {
    await database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

// 0047_backdrop_measure.sql (docs/branding.md, "Storage"): four nullable text columns for the measured range of the
// console background upload, lowercase #rrggbb, all four or none, and only on the console slot; the earlier rows
// survive the migration unchanged and start without a measurement.
test('backdrop measure: the four columns, their CHECKs, and unchanged earlier rows', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'serverdesk-backdrop-measure-'));
  const database = await testDatabase({ template: false });
  try {
    const names = await migrationNames(), migration = names.find(name => name.endsWith('_backdrop_measure.sql'));
    assert.equal(migration, '0047_backdrop_measure.sql', 'the migration of the measurement is 0047');
    const earlier = names.filter(name => name < migration);
    for (const name of earlier) await copyFile(path.join(directory, name), path.join(temporary, name));
    await migrateDatabase(database, { directory: temporary });
    const insert = ({ slot, hash }) => database.exec(sql`INSERT INTO branding_assets(customer_id,slot,content_type,data,size,width,height,sha256,updated_at,updated_by) VALUES(NULL,${slot},'image/png',decode('89898989','hex'),4,${1920},${1080},${hash},${at},'fixture')`);
    await insert({ slot: 'light', hash: 'a'.repeat(64) });
    await insert({ slot: 'console', hash: 'b'.repeat(64) });
    await database.exec(sql`INSERT INTO branding_settings(id,signin_background,console_background,updated_at,updated_by) VALUES(1,'mist','upload',${at},'fixture')`);
    const kept = async () => [await database.query(sql`SELECT customer_id,slot,content_type,size,width,height,sha256,updated_at,updated_by,encode(data,'hex') AS hex FROM branding_assets ORDER BY slot`), await database.query(sql`SELECT * FROM branding_settings`)];
    const before = await kept();
    await copyFile(path.join(directory, migration), path.join(temporary, migration));
    assert.deepEqual(await migrateDatabase(database, { directory: temporary }), { applied: 1, total: earlier.length + 1 });
    assert.deepEqual(await kept(), before, 'the earlier rows are unchanged');
    const columns = await database.query(sql`SELECT column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_name='branding_assets' AND column_name LIKE 'measure_%' ORDER BY ordinal_position`);
    assert.deepEqual(columns.map(row => [row.column_name, row.data_type, row.is_nullable, row.column_default]), ['measure_light_low', 'measure_light_high', 'measure_dark_low', 'measure_dark_high'].map(name => [name, 'text', 'YES', null]), 'four nullable text columns');
    assert.deepEqual(await database.query(sql`SELECT slot,measure_light_low,measure_light_high,measure_dark_low,measure_dark_high FROM branding_assets ORDER BY slot`), [
      { slot: 'console', measure_light_low: null, measure_light_high: null, measure_dark_low: null, measure_dark_high: null },
      { slot: 'light', measure_light_low: null, measure_light_high: null, measure_dark_low: null, measure_dark_high: null },
    ], 'an existing upload starts without a measurement');

    const refused = constraint => error => error.code === '23514' && error.constraint_name === constraint;
    const measure = (slot, [a, b, c, d]) => database.exec(sql`UPDATE branding_assets SET measure_light_low=${a},measure_light_high=${b},measure_dark_low=${c},measure_dark_high=${d} WHERE slot=${slot}`);
    await measure('console', ['#102030', '#a0b0c0', '#0f1f2f', '#909fa0']);
    assert.deepEqual(await database.one(sql`SELECT measure_light_low,measure_dark_high FROM branding_assets WHERE slot='console'`), { measure_light_low: '#102030', measure_dark_high: '#909fa0' }, 'a valid measurement on the console slot');
    await assert.rejects(measure('console', ['#10203G', '#a0b0c0', '#0f1f2f', '#909fa0']), refused('branding_assets_measure_hex'), 'a bad hex');
    await assert.rejects(measure('console', ['#102030', '#A0B0C0', '#0f1f2f', '#909fa0']), refused('branding_assets_measure_hex'), 'an upper-case hex');
    await assert.rejects(measure('console', ['#102030', '#a0b0c0', '#0f1f2f', null]), refused('branding_assets_measure_all'), 'three of four set');
    await assert.rejects(measure('light', ['#102030', '#a0b0c0', '#0f1f2f', '#909fa0']), refused('branding_assets_measure_console'), 'a measurement on a logo row');
    await measure('console', [null, null, null, null]);
    assert.deepEqual(await database.one(sql`SELECT measure_light_low FROM branding_assets WHERE slot='console'`), { measure_light_low: null }, 'all four cleared');
  } finally {
    await database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
