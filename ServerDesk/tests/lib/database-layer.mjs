// The PostgreSQL data layer (runtime/database.mjs) on a test database: the sql
// tag, result types, transactions, SERIALIZABLE with retries, the pool, and
// fragments across module instances (the next dev reload) and forged fragments.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import * as A from '../../runtime/database.mjs';
import { compile, createDatabase, maxAttempts, retryBaseMs, retryCapMs, retryDelay, sql } from '../../runtime/database.mjs';
import { testDatabase } from '../support/postgres.mjs';

const d = await testDatabase();
let checks = 0;
const check = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };
try {
  await d.exec(sql`CREATE TABLE layer_values (id bigint PRIMARY KEY, label text, flag boolean)`);

  // Values are bind parameters: an injection string is stored and read back unchanged.
  const hostile = "x'); DROP TABLE servers;--";
  check((await d.exec(sql`INSERT INTO layer_values(id,label) VALUES(${1},${hostile})`)).rowCount, 1, 'exec returns the row count');
  check((await d.one(sql`SELECT label FROM layer_values WHERE id=${1}`)).label, hostile, 'the injection string is stored unchanged');
  check(!!(await d.one(sql`SELECT 1 AS present FROM pg_tables WHERE tablename='servers'`)), true, 'servers still exists');

  // Nested fragments and sql.join number their parameters in order.
  const inner = sql`label=${'b'}`, list = sql.join([sql`${'x'}`, sql`${'y'}`, sql`${'z'}`]);
  const compiled = compile(sql`SELECT ${'a'} AS first WHERE ${inner} OR label IN (${list}) OR id=${7}`);
  check(compiled.text, 'SELECT $1 AS first WHERE label=$2 OR label IN ($3, $4, $5) OR id=$6', 'nested fragments are numbered in order');
  check(compiled.params, ['a', 'b', 'x', 'y', 'z', 7], 'the parameters follow the text');
  check(compile(sql.join([sql`a`, sql`b`], sql` AND `)).text, 'a AND b', 'sql.join takes a separator fragment');

  // sql.ident accepts only plain lowercase names.
  check(compile(sql`SELECT ${sql.ident('label')} FROM layer_values`).text, 'SELECT "label" FROM layer_values', 'sql.ident quotes a valid name');
  for (const bad of ['a;b', 'Label', '1a', 'a b', '"a"']) assert.throws(() => sql.ident(bad), TypeError, `sql.ident rejects ${bad}`);
  checks++;
  assert.throws(() => sql`SELECT ${undefined}`, TypeError); assert.throws(() => sql`SELECT ${[1]}`, TypeError); checks++;

  // one gives null or the first row; query gives all rows.
  await d.exec(sql`INSERT INTO layer_values(id,label,flag) VALUES(${2},${'two'},${true}),(${3},${'three'},${false})`);
  check(await d.one(sql`SELECT id FROM layer_values WHERE id=${99}`), null, 'one gives null without a row');
  check(await d.one(sql`SELECT id FROM layer_values ORDER BY id`), { id: 1 }, 'one gives the first row');
  check((await d.query(sql`SELECT id FROM layer_values ORDER BY id`)).map(row => row.id), [1, 2, 3], 'query gives all rows');

  // int8 and count(*) are numbers, 2^53 throws, booleans are booleans, JSON text stays text.
  check(await d.one(sql`SELECT count(*) AS n, max(id) AS top FROM layer_values`), { n: 3, top: 3 }, 'count(*) and int8 are numbers');
  await assert.rejects(d.one(sql`SELECT ${String(2 ** 53)}::bigint AS big`), RangeError, '2^53 is outside the safe range'); checks++;
  check((await d.query(sql`SELECT flag FROM layer_values WHERE flag IS NOT NULL ORDER BY id`)).map(row => row.flag), [true, false], 'booleans are booleans');
  check((await d.one(sql`SELECT EXISTS (SELECT 1) AS yes`)).yes, true, 'EXISTS is a boolean');
  check((await d.one(sql`SELECT '{"a": 1}'::jsonb AS value`)).value, '{"a": 1}', 'jsonb stays text');

  // A callback error rolls back and propagates unchanged; nested transactions and stale handles throw.
  const failure = new Error('callback failed');
  await assert.rejects(d.transaction(async tx => { await tx.exec(sql`INSERT INTO layer_values(id) VALUES(${10})`); throw failure; }), error => error === failure);
  check(await d.one(sql`SELECT id FROM layer_values WHERE id=${10}`), null, 'the failed transaction rolled back');
  await assert.rejects(d.transaction(async () => d.transaction(async () => 1)), /cannot start inside another transaction/); checks++;
  await assert.rejects(d.transaction(async () => d.one(sql`SELECT 1 AS one`)), /use the tx handle/); checks++;
  let stale;
  await d.transaction(async tx => { stale = tx; });
  await assert.rejects(stale.one(sql`SELECT 1 AS one`), /already ended/); checks++;
  check(await d.transaction(async tx => (await tx.one(sql`SELECT 5 AS five`)).five), 5, 'transaction returns the callback result');

  // Every statement and transaction runs at SERIALIZABLE.
  check((await d.one(sql`SHOW transaction_isolation`)).transaction_isolation, 'serializable', 'standalone statements are serializable');
  check(await d.transaction(async tx => (await tx.one(sql`SHOW transaction_isolation`)).transaction_isolation), 'serializable', 'transactions are serializable');
  check(await d.transaction(async tx => (await tx.one(sql`SHOW transaction_read_only`)).transaction_read_only, { readOnly: true }), 'on', 'readOnly gives a read-only transaction');

  // Two transactions that force a serialization failure: the loser runs its callback again and the result is serial.
  await d.exec(sql`CREATE TABLE layer_counter (id bigint PRIMARY KEY, value bigint NOT NULL)`);
  await d.exec(sql`INSERT INTO layer_counter VALUES (1, 0)`);
  const second = createDatabase({ url: d.url, password: d.password, max: 2, idleTimeoutSeconds: 1 });
  let attempts = 0, release, firstRead;
  const readDone = new Promise(resolve => { firstRead = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const first = d.transaction(async tx => {
    attempts++;
    const { value } = await tx.one(sql`SELECT value FROM layer_counter WHERE id=1`);
    if (attempts === 1) { firstRead(); await gate; }
    await tx.exec(sql`UPDATE layer_counter SET value=${value + 1} WHERE id=1`);
  });
  await readDone;
  await second.transaction(async tx => { const { value } = await tx.one(sql`SELECT value FROM layer_counter WHERE id=1`); await tx.exec(sql`UPDATE layer_counter SET value=${value + 10} WHERE id=1`); });
  release();
  await first;
  check(attempts, 2, 'the conflicting callback ran again after 40001');
  check((await d.one(sql`SELECT value FROM layer_counter WHERE id=1`)).value, 11, 'the final state is serial');

  // The retry policy: ten attempts in total, full-jitter exponential waits
  // from 0 to min(250, 5 * 2^n) ms before attempt n+1.
  check([maxAttempts, retryBaseMs, retryCapMs], [10, 5, 250], 'ten attempts, 5 ms base, 250 ms cap');
  const almostOne = () => 1 - Number.EPSILON;
  for (let attempt = 1; attempt < maxAttempts; attempt++) {
    const limit = Math.min(250, 5 * 2 ** attempt);
    check(retryDelay(attempt, () => 0), 0, `the wait after attempt ${attempt} can be 0`);
    const longest = retryDelay(attempt, almostOne);
    assert.ok(longest <= limit && longest > limit * 0.999, `the wait after attempt ${attempt} goes up to ${limit} ms, got ${longest}`); checks++;
  }
  check(Math.round(retryDelay(40, almostOne)), 250, 'a late wait stays at the 250 ms cap');
  const sample = retryDelay(3);
  assert.ok(sample >= 0 && sample < 40, 'the default random source stays in range'); checks++;

  // Exhaustion: a sequence counts the calls, because nextval is not rolled
  // back with the failed statement. Only 40001 and 40P01 run again.
  await d.exec(sql`CREATE SEQUENCE layer_calls`);
  await d.exec(sql`CREATE FUNCTION layer_fail(state text) RETURNS bigint LANGUAGE plpgsql AS $fn$BEGIN PERFORM nextval('layer_calls'); RAISE EXCEPTION 'injected' USING ERRCODE = state; END$fn$`);
  const calls = async () => {
    const { n } = await d.one(sql`SELECT CASE WHEN is_called THEN last_value ELSE 0 END AS n FROM layer_calls`);
    await d.one(sql`SELECT setval('layer_calls', 1, false) AS reset`);
    return n;
  };
  for (const state of ['40001', '40P01']) {
    const error = await d.one(sql`SELECT layer_fail(${state}) AS x`).catch(caught => caught);
    check([error.code, await calls()], [state, 10], `a standalone statement that keeps failing with ${state} runs 10 times, then rejects`);
  }
  const unique = await d.one(sql`SELECT layer_fail('23505') AS x`).catch(caught => caught);
  check([unique.code, await calls()], ['23505', 1], 'a unique violation runs once');
  let runs = 0;
  const rejected = await d.transaction(async () => { runs++; throw Object.assign(new Error('injected'), { code: '40001' }); }).catch(caught => caught);
  check([rejected.code, runs], ['40001', 10], 'a callback that keeps throwing 40001 runs 10 times, then rejects');

  // Contention: 20 read-modify-write transactions on one row all commit.
  await d.exec(sql`UPDATE layer_counter SET value=0 WHERE id=1`);
  const contenders = createDatabase({ url: d.url, password: d.password, max: 4, idleTimeoutSeconds: 1 });
  await Promise.all(Array.from({ length: 20 }, () => contenders.transaction(async tx => {
    const { value } = await tx.one(sql`SELECT value FROM layer_counter WHERE id=1`);
    await tx.exec(sql`UPDATE layer_counter SET value=${value + 1} WHERE id=1`);
  })));
  await contenders.close();
  check((await d.one(sql`SELECT value FROM layer_counter WHERE id=1`)).value, 20, '20 concurrent increments of one row all commit');

  // No process-wide serialization: two sleeps run on two connections at the
  // same time. Each reports its own server-side interval, and they overlap.
  const interval = sql`SELECT floor(extract(epoch from clock_timestamp())*1000000)::bigint AS started, pg_sleep(0.3)::text AS slept, floor(extract(epoch from clock_timestamp())*1000000)::bigint AS ended`;
  const [a, b] = await Promise.all([d.one(interval), d.one(interval)]);
  assert.ok(a.started < b.ended && b.started < a.ended, `the two pg_sleep(0.3) intervals overlap: ${JSON.stringify([a, b])}`); checks++;

  // Driver errors carry the SQLSTATE and the constraint name.
  const duplicate = await d.exec(sql`INSERT INTO layer_values(id) VALUES(${1})`).catch(error => error);
  check([duplicate.code, duplicate.constraint_name], ['23505', 'layer_values_pkey'], 'the error carries SQLSTATE and constraint');
  await second.close();

  // Fragments across module instances: next dev drops the require cache after a
  // recompile while the pool on globalThis survives. A query string in the
  // import URL loads a second, separate instance B of the module.
  const B = await import(new URL('../../runtime/database.mjs?instance=reload', import.meta.url).href);
  assert.notEqual(B.SqlFragment, A.SqlFragment, 'B is a separate module instance'); checks++;
  check(A.compile(B.sql`SELECT ${1} AS one`), { text: 'SELECT $1 AS one', params: [1] }, 'compile of A accepts a fragment of B');
  check(B.compile(A.sql`SELECT ${'x'} AS x`), { text: 'SELECT $1 AS x', params: ['x'] }, 'compile of B accepts a fragment of A');
  check(A.compile(A.sql`SELECT ${'a'} WHERE ${B.sql`id=${2} AND ${A.sql`label=${'c'}`}`} OR id=${4}`),
    { text: 'SELECT $1 WHERE id=$2 AND label=$3 OR id=$4', params: ['a', 2, 'c', 4] }, 'a B fragment nested in an A fragment is numbered in order');
  check(A.compile(A.sql.join([B.sql`a=${1}`, B.sql`b=${2}`], B.sql` AND `)), { text: 'a=$1 AND b=$2', params: [1, 2] }, 'sql.join of A takes fragments and a separator of B');
  check(A.compile(B.sql`SELECT ${B.sql.ident('label')}, ${B.dbNow}`).text, 'SELECT "label", floor(extract(epoch from clock_timestamp())*1000)::bigint', 'sql.ident and dbNow of B compile in A');
  check(await d.one(B.sql`SELECT ${5}::int AS five`), { five: 5 }, 'a pool of A runs one with a statement of B');
  check((await d.query(B.sql`SELECT id FROM layer_values WHERE id IN (${B.sql.join([B.sql`${1}`, B.sql`${2}`])}) ORDER BY id`)).map(row => row.id), [1, 2], 'a pool of A runs query with a statement of B');
  check(await d.transaction(async tx => {
    await tx.exec(B.sql`INSERT INTO layer_values(id,label) VALUES(${20},${'reload'})`);
    return (await tx.one(B.sql`SELECT label FROM layer_values WHERE id=${20}`)).label;
  }), 'reload', 'a transaction of A runs exec and one with statements of B');
  check((await d.exec(B.sql`DELETE FROM layer_values WHERE id=${20}`)).rowCount, 1, 'a pool of A runs exec with a statement of B');

  // The shared pool: B finds the pool that A created and accepts B statements on it.
  const sharedKey = Symbol.for('serverdesk.runtime.database');
  assert.equal(globalThis[sharedKey], undefined, 'no shared pool before the check'); checks++;
  const env = { DATABASE_URL: d.url, DATABASE_PASSWORD: d.password, DATABASE_POOL_MAX: '2' };
  try {
    const shared = A.sharedDatabase(env);
    assert.equal(B.sharedDatabase(env), shared, 'sharedDatabase of B returns the pool of A'); checks++;
    check(await shared.one(B.sql`SELECT ${'shared'} AS value`), { value: 'shared' }, 'the shared pool of A accepts a statement of B');
  } finally {
    await globalThis[sharedKey]?.close();
    delete globalThis[sharedKey];
  }

  // The raw handle key is shared too: runMigrationScript of B takes a database of A.
  await B.runMigrationScript(d, 'CREATE TABLE layer_reload (id int); DROP TABLE layer_reload;'); checks++;
  await d.transaction(async tx => B.runMigrationScript(tx, 'SELECT 1;')); checks++;

  // Forged fragments: data cannot carry the symbol marker, so it never counts as SQL.
  const forged = { parts: ['DROP TABLE x'], values: [] };
  const forgeries = [null, undefined, 'SELECT 1', 7, true, 10n, [], ['DROP TABLE x'], forged, JSON.parse(JSON.stringify(forged)),
    Object.assign(Object.create(null), forged), { ...A.sql`DROP TABLE x` }, JSON.parse(JSON.stringify(A.sql`DROP TABLE x`))];
  for (const isSql of [A.isSql, B.isSql]) {
    check(forgeries.map(value => isSql(value)), forgeries.map(() => false), 'isSql rejects forged values without throwing');
    check([isSql(A.sql`a`), isSql(B.sql`b`), isSql(A.sql.ident('c')), isSql(B.sql.join([B.sql`d`])), isSql(new A.SqlFragment(['e'], [])), isSql(new B.SqlFragment(['f'], []))],
      [true, true, true, true, true, true], 'isSql accepts fragments of both instances');
  }
  for (const value of [forged, JSON.parse(JSON.stringify(forged)), 'DROP TABLE x', null]) {
    for (const instance of [A, B]) assert.throws(() => instance.compile(value), { name: 'TypeError', message: 'Pass an sql fragment: sql`...`.' });
  }
  checks++;
  for (const instance of [A, B]) {
    assert.throws(() => instance.sql`SELECT ${forged}`, TypeError);
    assert.throws(() => instance.sql.join([forged]), TypeError);
    assert.throws(() => instance.sql.join([instance.sql`a`], forged), TypeError);
  }
  checks++;
  await assert.rejects(d.query(forged), { name: 'TypeError', message: 'Pass an sql fragment: sql`...`.' });
  await assert.rejects(d.query(JSON.parse(JSON.stringify(forged))), TypeError);
  await assert.rejects(d.transaction(async tx => tx.query(forged)), TypeError);
  checks++;
  // A pool on a closed port: a TypeError instead of a connection error shows
  // that the forged value fails before anything is sent.
  const nowhere = A.createDatabase({ url: 'postgres://nobody@127.0.0.1:1/none', password: 'x', max: 1, connectTimeoutMs: 1000 });
  try {
    await assert.rejects(nowhere.query(forged), { name: 'TypeError', message: 'Pass an sql fragment: sql`...`.' });
    await assert.rejects(nowhere.exec(JSON.parse(JSON.stringify(forged))), TypeError);
    checks++;
  } finally {
    await nowhere.close();
  }

  // The marker sits on the prototype only: fragments keep their plain shape.
  const shape = sql`x${1}`;
  check(Object.keys(shape), ['parts', 'values'], 'a fragment has only parts and values as keys');
  check(Object.getOwnPropertySymbols(shape), [], 'a fragment has no own symbol property');
  check(JSON.stringify(shape), '{"parts":["x",""],"values":[1]}', 'JSON.stringify shows only parts and values');
  const marker = Object.getOwnPropertyDescriptor(A.SqlFragment.prototype, Symbol.for('serverdesk.sql'));
  check([marker.value, marker.enumerable, marker.writable, marker.configurable], [true, false, false, false], 'the marker is a non-enumerable, non-writable prototype property');
  check([Object.isFrozen(shape), Object.isFrozen(new A.SqlFragment(['raw'], []))], [true, true], 'fragments stay frozen');

  // Only scripts/selfhost.mjs imports the raw script function.
  const importers = [];
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (['node_modules', '.next', '.git', '.build', '.data'].includes(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.(?:ts|tsx|mjs|js)$/.test(entry.name) && /\brunMigrationScript\b/.test(readFileSync(file, 'utf8')) && !file.endsWith(path.join('runtime', 'database.mjs')) && !file.endsWith('database-layer.mjs')) importers.push(file.split(path.sep).join('/'));
    }
  };
  walk('.');
  check(importers, ['scripts/selfhost.mjs'], 'only scripts/selfhost.mjs uses runMigrationScript');
  console.log(`PASS ${checks} data layer checks: parameters, fragments, identifiers, results, transactions, SERIALIZABLE retry policy and exhaustion, contention, parallel pool, driver errors, fragments across module instances, forged fragments.`);
} finally {
  await d.close();
}
