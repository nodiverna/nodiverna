import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createDatabase,sql,SqlFragment} from '../../runtime/database.mjs';
import { createTestDatabase, testDatabase } from '../support/postgres.mjs';
import { enableMultipleCustomers } from '../support/customer-separation.mjs';
import { migrateDatabase } from '../../scripts/selfhost.mjs';
import { licenseServer, portalVersion, sendUsageReport, usageDataEnabled, usagePayload } from '../../runtime/usage-report.mjs';
import { serverDeskRoot } from '../support/paths.mjs';

// The usage data row, the payload, the client of the usage data server and the
// maintenance command. Real migrations on an empty PostgreSQL test database;
// the usage data server is a recording fake fetch or a local node:http server on
// 127.0.0.1. Nothing leaves this machine. Usage data is off in this version
// (usageDataEnabled): the maintenance command reports "disabled" and sends nothing.
// The send path checks pass enabled:true, the way the function works once turned on.
const projectRoot = serverDeskRoot;
const packageVersion = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
const hour = 3_600_000;
const now = Date.UTC(2026, 9, 18, 12);

async function fixture(run) {
  const database = await testDatabase({ template: false });
  try {
    await migrateDatabase(database);
    return await run({ database, url: database.url, password: database.password });
  } finally {
    await database.close();
  }
}

const row = database => database.query(sql`SELECT * FROM usage_data`).then(results=>({results})).then(result => { assert.equal(result.results.length, 1); return result.results[0]; });
const setConsent = (database, consent) => database.exec(sql`UPDATE usage_data SET consent=${consent} WHERE id=1`);
const failsWith = (promise, code) => assert.rejects(promise, error => { assert.match(String(error?.message ?? error), new RegExp(code)); return true; });
// A database that throws on every access proves "no database access at all".
const untouchable = new Proxy({}, { get(_target, key) { throw new Error(`database touched: ${String(key)}`); } });

// A recording fake fetch with a scripted answer per call.
function recorder(answer = () => new Response(null, { status: 204 })) {
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, init }); return answer(calls.length, url, init); };
  return { calls, fetch };
}
const configured = { LICENSE_SERVER_URL: 'https://lizenz.example.com' };

test('the migration creates one protected row with a random instance id', async () => {
  const ids = [];
  for (let run = 0; run < 2; run++) await fixture(async ({ database }) => {
    const current = await row(database);
    assert.match(current.instance_id, /^[0-9a-f]{32}$/);
    assert.deepEqual({ ...current, instance_id: '' }, { id: 1, instance_id: '', consent: null, decided_at: null, decided_by: null, last_attempt_at: null, last_success_at: null, last_error: null, revision: 0 });
    ids.push(current.instance_id);
    await failsWith(database.exec(sql`INSERT INTO usage_data(id,instance_id) VALUES(2,${'a'.repeat(32)})`), 'usage-data-protected');
    await failsWith(database.exec(sql`INSERT INTO usage_data(id,instance_id) VALUES(1,${'b'.repeat(32)}) ON CONFLICT(id) DO UPDATE SET instance_id=excluded.instance_id`), 'usage-data-protected');
    await failsWith(database.exec(sql`DELETE FROM usage_data`), 'usage-data-protected');
    await failsWith(database.exec(sql`UPDATE usage_data SET instance_id=${'c'.repeat(32)} WHERE id=1`), 'usage-instance-immutable');
    await failsWith(database.exec(sql`UPDATE usage_data SET consent=2 WHERE id=1`), 'check constraint');
    await failsWith(database.exec(sql`UPDATE usage_data SET last_error=${'x'.repeat(41)} WHERE id=1`), 'check constraint');
    await failsWith(database.exec(sql`UPDATE usage_data SET id=2 WHERE id=1`), 'check constraint');
    await database.exec(sql`UPDATE usage_data SET last_error=${'x'.repeat(40)}, consent=0 WHERE id=1`);
    await database.exec(sql`UPDATE usage_data SET instance_id=instance_id WHERE id=1`);
    assert.equal((await row(database)).instance_id, current.instance_id, 'the instance id never changes');
  });
  assert.notEqual(ids[0], ids[1], 'two fresh databases get different ids');
});

test('the payload has exactly four keys and nothing personal', async () => fixture(async ({ database }) => {
  const site = 'https://portal.geheim.example';
  await database.exec(enableMultipleCustomers());
  await database.exec(sql`INSERT INTO customers(id,name,created_at,updated_at) VALUES(${randomUUID()},${'Kunde Geheim GmbH'},${now},${now})`);
  await database.exec(sql`INSERT INTO local_users(id,username,email,display_name,auth_principal,auth_email,status,created_at,updated_at) VALUES(${randomUUID()},${'max.geheim'},${'max@geheim.example'},${'Max Geheim'},${'local:max-geheim'},${'max@geheim.example'},'active',${now},${now})`);
  for (const [name, revoked] of [['HOST-GEHEIM-01', 0], ['HOST-GEHEIM-02', 0], ['HOST-GEHEIM-ALT', 1]]) {
    await database.exec(sql`INSERT INTO servers(id,name,token_hash,created_at,revoked,snapshot) VALUES(${randomUUID()},${name},${'fixture-' + randomUUID()},${now},${revoked},${JSON.stringify({ hostname: name, domain: 'geheim.local', networks: [{ addresses: ['10.9.8.7'] }] })})`);
  }
  const payload = await usagePayload(database);
  assert.deepEqual(Object.keys(payload), ['schema', 'instanceId', 'version', 'deviceCount']);
  assert.deepEqual(payload, { schema: 2, instanceId: (await row(database)).instance_id, version: packageVersion, deviceCount: 2 });
  assert.equal(payload.version, portalVersion(), 'the route and the maintenance command use the same version');
  const json = JSON.stringify(await usagePayload(database));
  for (const secret of ['Kunde Geheim', 'max', 'geheim', 'HOST', '10.9.8.7', site, 'local:']) assert.equal(json.toLowerCase().includes(secret.toLowerCase()), false, secret);
  // The sent body is exactly this payload, also with SITE_ORIGIN set.
  await setConsent(database, 1);
  const server = recorder();
  assert.deepEqual(await sendUsageReport(database, { enabled: true, env: { ...configured, SITE_ORIGIN: site }, fetch: server.fetch, now }), { status: 'sent' });
  assert.equal(server.calls[0].init.body, json);
}));

test('portalVersion accepts semantic versions and reports unknown otherwise', () => {
  assert.equal(portalVersion(), packageVersion);
  for (const value of ['1.2.3', '0.1.0', '1.2.3-beta.1', '1.2.3+build.5', '10.20.30-rc-1']) assert.equal(portalVersion(value), value);
  for (const value of [null, '', '1.2', 'v1.2.3', '1.2.3 ', '1.2.3-', 'latest', 1]) assert.equal(portalVersion(value), 'unknown', String(value));
});

test('LICENSE_SERVER_URL rules', () => {
  assert.deepEqual(licenseServer(undefined), { state: 'none' });
  assert.deepEqual(licenseServer(''), { state: 'none' });
  for (const value of ['http://example.com', 'https://u:p@example.com', 'https://u@example.com', 'ftp://example.com', 'https://example.com/?a=1', 'https://example.com/?', 'https://example.com/#x', 'kein-url', 'http://10.0.0.1'])
    assert.deepEqual(licenseServer(value), { state: 'invalid' }, value);
  assert.deepEqual(licenseServer('https://lizenz.example.com'), { state: 'configured', base: 'https://lizenz.example.com/' });
  assert.deepEqual(licenseServer('https://example.com/serverdesk/'), { state: 'configured', base: 'https://example.com/serverdesk/' });
  assert.deepEqual(licenseServer('https://example.com/serverdesk'), { state: 'configured', base: 'https://example.com/serverdesk/' });
  for (const host of ['localhost', '127.0.0.1', '[::1]']) assert.equal(licenseServer(`http://${host}:8080/x`).state, 'configured', host);
});

test('the switch is off: nothing is sent, whatever is stored', async () => fixture(async ({ database }) => {
  assert.equal(usageDataEnabled(configured), false);
  await setConsent(database, 1);
  const before = await row(database), server = recorder();
  for (const env of [configured, {}, { LICENSE_SERVER_URL: 'kein-url' }, undefined]) {
    assert.deepEqual(await sendUsageReport(untouchable, { env, fetch: server.fetch, now }), { status: 'disabled' }, 'no database access at all');
    assert.deepEqual(await sendUsageReport(database, { env, fetch: server.fetch, now }), { status: 'disabled' });
    assert.deepEqual(await sendUsageReport(untouchable, { env, fetch: server.fetch, now, enabled: false }), { status: 'disabled' });
  }
  assert.deepEqual([await row(database), server.calls.length], [before, 0], 'the row is unchanged and no request was made');
}));

test('without a server, with an invalid URL or without consent nothing is sent', async () => fixture(async ({ database }) => {
  await setConsent(database, 1);
  const before = await row(database), server = recorder();
  for (const env of [{}, { LICENSE_SERVER_URL: '' }, { LICENSE_SERVER_URL: '   ' }, undefined]) {
    assert.deepEqual(await sendUsageReport(untouchable, { enabled: true, env, fetch: server.fetch, now }), { status: 'no-server' }, 'no database access at all');
    assert.deepEqual(await sendUsageReport(database, { enabled: true, env, fetch: server.fetch, now }), { status: 'no-server' });
  }
  for (const value of ['http://example.com', 'https://u:p@example.com', 'ftp://example.com', 'https://example.com/?a=1', 'https://example.com/#x', 'kein-url']) {
    assert.deepEqual(await sendUsageReport(untouchable, { enabled: true, env: { LICENSE_SERVER_URL: value }, fetch: server.fetch, now }), { status: 'invalid-server' }, value);
    assert.deepEqual(await sendUsageReport(database, { enabled: true, env: { LICENSE_SERVER_URL: value }, fetch: server.fetch, now }), { status: 'invalid-server' }, value);
  }
  assert.deepEqual(await row(database), before, 'the row is unchanged byte for byte');
  for (const consent of [null, 0]) {
    await setConsent(database, consent);
    const undecided = await row(database);
    assert.deepEqual(await sendUsageReport(database, { enabled: true, env: configured, fetch: server.fetch, now }), { status: 'no-consent' });
    assert.deepEqual(await row(database), undecided);
  }
  assert.equal(server.calls.length, 0, 'no network request');
}));

test('with consent the report is sent once and is due again after 20 hours', async () => fixture(async ({ database }) => {
  await setConsent(database, 1);
  for (const [base, endpoint] of [['https://lizenz.example.com', 'https://lizenz.example.com/v1/usage'], ['https://example.com/serverdesk/', 'https://example.com/serverdesk/v1/usage']]) {
    await database.exec(sql`UPDATE usage_data SET last_attempt_at=NULL, last_success_at=NULL WHERE id=1`);
    const server = recorder();
    assert.deepEqual(await sendUsageReport(database, { enabled: true, env: { LICENSE_SERVER_URL: base }, fetch: server.fetch, now }), { status: 'sent' });
    assert.equal(server.calls.length, 1);
    const [{ url, init }] = server.calls;
    assert.equal(url, endpoint);
    assert.equal(init.method, 'POST');
    assert.deepEqual(init.headers, { 'Content-Type': 'application/json', 'User-Agent': `ServerDesk/${packageVersion}` });
    assert.equal(init.redirect, 'error');
    assert.equal(init.credentials, 'omit');
    assert.ok(init.signal instanceof AbortSignal, 'the request has a timeout signal');
    assert.deepEqual(JSON.parse(init.body), await usagePayload(database));
    const current = await row(database);
    assert.deepEqual([current.last_attempt_at, current.last_success_at, current.last_error], [now, now, null]);
  }
  const server = recorder();
  assert.deepEqual(await sendUsageReport(database, { enabled: true, env: configured, fetch: server.fetch, now: now + 20 * hour - 60_000 }), { status: 'not-due' });
  assert.equal(server.calls.length, 0, '19 h 59 min later nothing is sent');
  assert.deepEqual(await sendUsageReport(database, { enabled: true, env: configured, fetch: server.fetch, now: now + 20 * hour }), { status: 'sent' });
  assert.equal(server.calls.length, 1, 'after 20 hours it is sent again');
  assert.equal((await row(database)).last_success_at, now + 20 * hour);
}));

test('failures are recorded without changing the last success and are due again after 20 hours', async () => fixture(async ({ database }) => {
  await setConsent(database, 1);
  const ok = recorder();
  assert.deepEqual(await sendUsageReport(database, { enabled: true, env: configured, fetch: ok.fetch, now }), { status: 'sent' });
  const timeout = () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); };
  const cases = [
    ['http-500', () => new Response('<html>internal details</html>', { status: 500 })],
    ['http-301', () => new Response(null, { status: 301, headers: { Location: 'https://elsewhere.example' } })],
    // redirect:'error' makes fetch reject on a redirect.
    ['network', () => { throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') }); }],
    ['timeout', timeout],
    ['network', () => { throw new Error('ECONNREFUSED'); }],
    ['network', () => { const error = new DOMException('aborted', 'AbortError'); throw error; }],
  ];
  let at = now;
  for (const [error, answer] of cases) {
    at += 20 * hour;
    const server = recorder(answer);
    assert.deepEqual(await sendUsageReport(database, { enabled: true, env: configured, fetch: server.fetch, now: at }), { status: 'failed', error }, error);
    assert.equal(server.calls.length, 1);
    const current = await row(database);
    assert.deepEqual([current.last_error, current.last_success_at, current.last_attempt_at], [error, now, at], error);
    assert.deepEqual(await sendUsageReport(database, { enabled: true, env: configured, fetch: server.fetch, now: at + 20 * hour - 60_000 }), { status: 'not-due' }, 'a failed attempt is due only after 20 hours');
    assert.equal(server.calls.length, 1);
  }
  at += 20 * hour;
  assert.deepEqual(await sendUsageReport(database, { enabled: true, env: configured, fetch: ok.fetch, now: at }), { status: 'sent' });
  assert.deepEqual([(await row(database)).last_error, (await row(database)).last_success_at], [null, at], 'a success clears the error');
  // A missing fetch or a broken database never throws.
  await database.exec(sql`UPDATE usage_data SET last_attempt_at=NULL WHERE id=1`);
  assert.deepEqual(await sendUsageReport(database, { enabled: true, env: configured, fetch: undefined, now: at + 21 * hour }), { status: 'failed', error: 'network' });
  const broken = { query() { throw new Error('I/O error'); }, one() { throw new Error('I/O error'); }, exec() { throw new Error('I/O error'); }, transaction() { throw new Error('I/O error'); } };
  assert.deepEqual(await sendUsageReport(broken, { enabled: true, env: configured, fetch: ok.fetch, now }), { status: 'failed', error: 'internal' });
}));

test('concurrent runs send once, and a withdrawn consent stops the next run', async () => fixture(async ({ database, url, password }) => {
  await setConsent(database, 1);
  const server = recorder();
  const results = await Promise.all([sendUsageReport(database, { enabled: true, env: configured, fetch: server.fetch, now }), sendUsageReport(database, { enabled: true, env: configured, fetch: server.fetch, now })]);
  assert.deepEqual(results.map(result => result.status).sort(), ['not-due', 'sent']);
  assert.equal(server.calls.length, 1, 'one adapter: one request');
  // Two connections behave like two maintenance processes.
  const second = createDatabase({ url, password, max: 2 });
  try {
    const later = now + 20 * hour;
    const both = await Promise.all([sendUsageReport(database, { enabled: true, env: configured, fetch: server.fetch, now: later }), sendUsageReport(second, { enabled: true, env: configured, fetch: server.fetch, now: later })]);
    assert.deepEqual(both.map(result => result.status).sort(), ['not-due', 'sent']);
    assert.equal(server.calls.length, 2, 'two connections: one more request');
  } finally { await second.close(); }
  await setConsent(database, 0);
  assert.deepEqual(await sendUsageReport(database, { enabled: true, env: configured, fetch: server.fetch, now: now + 60 * hour }), { status: 'no-consent' });
  assert.equal(server.calls.length, 2, 'no further request after the withdrawal');
}));

// ---- The maintenance command against a local usage data server ------------------------
function run(args, env) {
  return new Promise((resolve, reject) => {
    // The child never reaches GitHub: its release check fails offline (tests/support/offline-fetch.mjs).
    const child = spawn(process.execPath, ['--import', './tests/support/offline-fetch.mjs', 'scripts/selfhost.mjs', ...args], { cwd: projectRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => child.kill(), 60_000);
    child.on('error', reject);
    child.on('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

test('maintenance sends no report while usage data is off; the client reaches a local server once on', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'serverdesk-usage-cli-'));
  const target = await createTestDatabase({ template: false });
  const requests = [];
  let answer = 204;
  const listener = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8').on('data', chunk => { body += chunk; }).on('end', () => {
      requests.push({ method: request.method, url: request.url, headers: request.headers, body });
      response.writeHead(answer, { 'Content-Type': 'text/plain' }).end('secret server answer');
    });
  });
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const serverUrl = `http://127.0.0.1:${listener.address().port}/lizenz`;
  const environment = { ...process.env, DATABASE_URL: target.url, DATABASE_PASSWORD: target.password, OBJECT_STORAGE_DRIVER: 'filesystem', OBJECT_STORAGE_PATH: path.join(directory, 'objects') };
  for (const key of ['AUDIT_RETENTION_DAYS', 'JOB_RETENTION_DAYS', 'LICENSE_SERVER_URL']) delete environment[key];
  const withServer = { ...environment, LICENSE_SERVER_URL: serverUrl };
  // text is fixture SQL without values.
  const edit = async text => { const database = createDatabase({ url: target.url, password: target.password, max: 1 }); try { await database.exec(new SqlFragment([text], [])); return await row(database); } finally { await database.close(); } };
  const report = result => { const output = JSON.parse(result.stdout); assert.deepEqual(Object.keys(output).slice(-2), ['usageReport', 'releaseImport'], 'the release check follows the usage report'); return output.usageReport; };
  try {
    // A failing maintenance run (no migrations yet) sends nothing.
    const unmigrated = await run(['maintenance'], withServer);
    assert.equal(unmigrated.status, 1);
    assert.equal(requests.length, 0);

    assert.equal((await run(['migrate'], environment)).status, 0);
    const { instance_id: instanceId } = await edit('UPDATE usage_data SET consent=1 WHERE id=1');
    // Off: a valid address, stored consent and a due attempt send nothing, with no notice and exit code 0.
    for (const env of [withServer, environment, { ...environment, LICENSE_SERVER_URL: 'http://example.com/lizenz' }]) {
      const off = await run(['maintenance'], env);
      assert.deepEqual([off.status, report(off), off.stderr, requests.length], [0, { status: 'disabled' }, '', 0], off.stderr);
    }
    const kept = await edit('SELECT 1');
    assert.deepEqual([kept.consent, kept.last_attempt_at, kept.last_success_at], [1, null, null], 'the maintenance claimed no attempt');

    // Once on, the client posts exactly the payload to the local server.
    const database = createDatabase({ url: target.url, password: target.password, max: 1 });
    try {
      const sent = await sendUsageReport(database, { enabled: true, env: { LICENSE_SERVER_URL: serverUrl }, fetch: globalThis.fetch, now });
      assert.deepEqual(sent, { status: 'sent' });
      assert.equal(requests.length, 1, 'exactly one request');
      assert.equal(requests[0].method, 'POST');
      assert.equal(requests[0].url, '/lizenz/v1/usage');
      assert.equal(requests[0].headers['content-type'], 'application/json');
      assert.equal(requests[0].headers['user-agent'], `ServerDesk/${packageVersion}`);
      assert.deepEqual(JSON.parse(requests[0].body), { schema: 2, instanceId, version: packageVersion, deviceCount: 0 });
      // Within 20 hours nothing more; a 500 answer is a failure code without the answer text.
      assert.deepEqual(await sendUsageReport(database, { enabled: true, env: { LICENSE_SERVER_URL: serverUrl }, fetch: globalThis.fetch, now: now + hour }), { status: 'not-due' });
      answer = 500;
      assert.deepEqual(await sendUsageReport(database, { enabled: true, env: { LICENSE_SERVER_URL: serverUrl }, fetch: globalThis.fetch, now: now + 20 * hour }), { status: 'failed', error: 'http-500' });
      assert.equal(requests.length, 2);
    } finally { await database.close(); }
  } finally {
    await new Promise(resolve => listener.close(resolve));
    await target.drop();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
