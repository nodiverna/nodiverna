// 0006_seed_customer_timestamps.sql: the first customer's seed row gets one
// timestamp. The baseline seed reads the clock twice, so created_at and
// updated_at can differ by a millisecond. The migration closes a gap of 1 to
// 1000 ms on that row only, applies once, and contains no schema statement.
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sql } from '../../runtime/database.mjs';
import { migrateDatabase } from '../../scripts/selfhost.mjs';
import { testDatabase } from '../support/postgres.mjs';

const shipped = fileURLToPath(new URL('../../drizzle/', import.meta.url));
const seedMigration = '0006_seed_customer_timestamps.sql';
const firstCustomer = '00000000-0000-4000-8000-000000000100';
const otherCustomer = '00000000-0000-4000-8000-0000000001ff';

const timestamps = (database, id) => database.one(sql`SELECT created_at,updated_at FROM customers WHERE id=${id}`);
const journalNames = async database => (await database.query(sql`SELECT name FROM _serverdesk_migrations ORDER BY name`)).map(row => row.name);

/** An empty database migrated with the shipped migrations before 0006; then 0006 is added to the directory. */
async function beforeSeedFix(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'serverdesk-seed-timestamps-'));
  const database = await testDatabase({ template: false });
  try {
    const earlier = (await readdir(shipped)).filter(name => /^\d{4}_.+\.sql$/.test(name) && name < seedMigration).sort();
    assert.deepEqual(earlier.slice(0, 6).map(name => name.slice(0, 4)), ['0000', '0001', '0002', '0003', '0004', '0005']);
    for (const name of earlier) await copyFile(path.join(shipped, name), path.join(directory, name));
    assert.deepEqual(await migrateDatabase(database, { directory }), { applied: earlier.length, total: earlier.length });
    const addSeedFix = () => copyFile(path.join(shipped, seedMigration), path.join(directory, seedMigration));
    return await run({ database, directory, addSeedFix, total: earlier.length + 1 });
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('a 1 ms gap of the first customer closes once, and a second migrate applies nothing', async () => {
  await beforeSeedFix(async ({ database, directory, addSeedFix, total }) => {
    await database.exec(sql`UPDATE customers SET updated_at=created_at+1 WHERE id=${firstCustomer}`);
    const before = await timestamps(database, firstCustomer);
    await addSeedFix();
    assert.deepEqual(await migrateDatabase(database, { directory }), { applied: 1, total });
    assert.deepEqual(await timestamps(database, firstCustomer), { created_at: before.created_at, updated_at: before.created_at });
    assert.equal((await journalNames(database)).filter(name => name === seedMigration).length, 1, 'journaled once');
    assert.deepEqual(await migrateDatabase(database, { directory }), { applied: 0, total });
  });
});

test('a gap of 1000 ms still closes; equal timestamps, a later edit and other customers stay', async () => {
  await beforeSeedFix(async ({ database, directory, addSeedFix, total }) => {
    await database.exec(sql`UPDATE customers SET updated_at=created_at+1000 WHERE id=${firstCustomer}`);
    await addSeedFix();
    await migrateDatabase(database, { directory });
    const edge = await timestamps(database, firstCustomer);
    assert.equal(edge.updated_at, edge.created_at, 'the upper end of the window is closed');
    assert.equal((await migrateDatabase(database, { directory })).total, total);
  });
  await beforeSeedFix(async ({ database, directory, addSeedFix }) => {
    await database.exec(sql`UPDATE customers SET updated_at=created_at WHERE id=${firstCustomer}`);
    const equal = await timestamps(database, firstCustomer);
    await addSeedFix();
    await migrateDatabase(database, { directory });
    assert.deepEqual(await timestamps(database, firstCustomer), equal, 'equal timestamps stay');
  });
  await beforeSeedFix(async ({ database, directory, addSeedFix }) => {
    await database.exec(sql`UPDATE customers SET updated_at=created_at+5000 WHERE id=${firstCustomer}`);
    await database.exec(sql`INSERT INTO customers(id,name,created_at,updated_at) VALUES(${otherCustomer},'Kunde B',1800000000000,1800000000001)`);
    const first = await timestamps(database, firstCustomer), other = await timestamps(database, otherCustomer);
    await addSeedFix();
    await migrateDatabase(database, { directory });
    assert.deepEqual(await timestamps(database, firstCustomer), first, 'a gap above 1000 ms is a later edit and stays');
    assert.deepEqual(await timestamps(database, otherCustomer), other, 'another customer with a 1 ms gap stays');
  });
});

test('the shipped migrations give the first customer one timestamp', async () => {
  const database = await testDatabase({ template: false });
  try {
    await migrateDatabase(database);
    const customer = await timestamps(database, firstCustomer);
    assert.equal(customer.created_at, customer.updated_at);
  } finally { await database.close(); }
});

test('0006 is one data statement without schema changes or raised errors', async () => {
  const source = await readFile(path.join(shipped, seedMigration), 'utf8');
  const code = source.split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n');
  assert.doesNotMatch(code, /\b(CREATE|ALTER|DROP|RAISE|INSERT|DELETE|TRUNCATE)\b/i);
  assert.equal(code.split(';').filter(part => part.trim()).length, 1, 'exactly one statement');
  assert.match(code, /^UPDATE customers SET updated_at=created_at\b/m);
  assert.match(code, /id='00000000-0000-4000-8000-000000000100'/);
  assert.match(code, /updated_at-created_at BETWEEN 1 AND 1000/);
});
