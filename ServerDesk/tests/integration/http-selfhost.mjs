import {serverText} from '../support/server-text.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, verify } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {createDatabase,sql} from '../../runtime/database.mjs';
import { migrateDatabase, bootstrapOwner } from '../../scripts/selfhost.mjs';
import { fixtureTotp } from '../support/mfa-fixture.mjs';
import { prepareStandalone } from '../../scripts/prepare-standalone.mjs';
import { createTestDatabase } from '../support/postgres.mjs';
import { crossCustomerPermission, crossCustomerPermissionLabelKey } from '../../lib/cross-customer-right.ts';

// The signed update path always runs: pnpm test:http (scripts/http-test.mjs)
// pins a throwaway test publisher in a copy of the tree and passes its key.
const publisherKeyFile = process.env.SERVERDESK_TEST_PUBLISHER_KEY_FILE;
const pinned = JSON.parse(await readFile(new URL('../../lib/release-publisher.json', import.meta.url), 'utf8')).publicKey;
let publisherPublicKey;
try { publisherPublicKey = createPublicKey(createPrivateKey(await readFile(publisherKeyFile ?? ''))); } catch { publisherPublicKey = null; }
const spki = key => (typeof key === 'string' ? createPublicKey(key) : key).export({ type: 'spki', format: 'der' });
if (!publisherKeyFile || !publisherPublicKey || !spki(publisherPublicKey).equals(spki(pinned))) {
  console.error('tests/integration/http-selfhost.mjs needs SERVERDESK_TEST_PUBLISHER_KEY_FILE with the private key of the publisher pinned in lib/release-publisher.json of this tree. Run it through pnpm test:http, which pins a throwaway test publisher in a copy of the tree.');
  process.exit(1);
}
const temporary = await mkdtemp(path.join(os.tmpdir(), 'serverdesk-http-'));
async function freePort() {
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const free = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return free;
}
const port = await freePort();
// An empty PostgreSQL test database for the portal; it is dropped at the end.
const target = await createTestDatabase({ template: false });
const origin = `http://localhost:${port}`;
const configuration = {
  ...process.env,
  // Requests use a loopback socket; application origin remains HTTPS so the
  // real signed-release and Secure-cookie policies are exercised unchanged.
  SITE_ORIGIN: 'https://portal.test',
  SESSION_SECRET: randomBytes(48).toString('base64url'),
  PASSWORD_PEPPER: randomBytes(48).toString('base64url'),
  DATABASE_URL: target.url, DATABASE_PASSWORD: target.password,
  OBJECT_STORAGE_DRIVER: 'filesystem', OBJECT_STORAGE_PATH: path.join(temporary, 'objects'),
  TRUSTED_CLIENT_IP_HEADER: '',
  AGENT_JOB_SIGNING_KEY: generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  NEXT_TELEMETRY_DISABLED: '1',
  // No license server, so the usage data report stays local.
  LICENSE_SERVER_URL: '',
  // No scheduled maintenance during the checks; the last start below runs it.
  MAINTENANCE_SCHEDULER: 'off',
};
const database = createDatabase({ url: target.url, password: target.password, max: 2 });
let output = '', child;
// Session tokens travel only in HttpOnly cookies. The cookie jar keeps
// what Set-Cookie sends (name=value; Max-Age=0 deletes) and returns it as one
// Cookie header. No request carries X-ServerDesk-Session or X-ServerDesk-Mfa.
let jar = new Map();
function remember(response) {
  for (const raw of response.headers.getSetCookie()) {
    const [pair, ...attributes] = raw.split(';').map(part => part.trim());
    const split = pair.indexOf('=');
    if (split < 1) continue;
    const name = pair.slice(0, split), value = pair.slice(split + 1);
    if (!value || attributes.some(attribute => /^max-age=0$/i.test(attribute))) jar.delete(name); else jar.set(name, value);
  }
}
const cookieHeader = () => [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
const call = async (pathname, payload, extra = {}) => {
  const response = await fetch(origin + pathname, {
    ...(payload === undefined ? {} : { method: 'POST', body: JSON.stringify(payload) }),
    headers: { Origin: configuration.SITE_ORIGIN, 'Content-Type': 'application/json', ...(jar.size ? { Cookie: cookieHeader() } : {}), ...extra },
  });
  remember(response);
  return response;
};
// Every accepted reply: no token field and no cookie value in the body.
async function accepted(response, message) {
  const text = await response.text();
  const value = JSON.parse(text);
  assert.equal(response.status, 200, `${message}: ${text}`);
  assert.ok(!('proofToken' in value) && !('identityToken' in value), `${message}: the body has no session token field`);
  for (const [name, cookie] of jar) assert.ok(!text.includes(cookie), `${message}: the body does not carry the ${name} cookie value`);
  return value;
}
// Session, trust and primary cookies: SameSite=Strict, never SameSite=None or Partitioned.
function strictSessionCookies(response, message) {
  const cookies = response.headers.getSetCookie().filter(raw => /^__Host-serverdesk-(?:auth|mfa|mfa-trust)=/.test(raw));
  assert.ok(cookies.length > 0, `${message}: session cookies are set`);
  for (const raw of cookies) {
    assert.match(raw, /; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=\d+$/, `${message}: ${raw.split('=')[0]} is a Strict host cookie`);
    assert.doesNotMatch(raw, /SameSite=None|Partitioned|-embedded=/i, `${message}: no partitioned or embedded cookie`);
  }
}

// Every response the proxy handles in production carries the one
// complete per-request nonce policy, enforced. This server runs with
// an https: SITE_ORIGIN, so it includes upgrade-insecure-requests. No response
// carries a report-only policy. Only bypassed build assets keep the baseline
// from next.config.ts.
const baselinePolicy = "base-uri 'self'; object-src 'none'; frame-ancestors 'self'";
const enforcedPolicy = (nonce, upgrade = true) => `${baselinePolicy}; script-src 'self' 'nonce-${nonce}' 'strict-dynamic'; connect-src 'self'; default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; frame-src 'self'; worker-src 'self'; form-action 'self'; ${upgrade ? 'upgrade-insecure-requests; ' : ''}report-uri /api/csp-report; report-to csp-endpoint`;
const reportingEndpoints = 'csp-endpoint="/api/csp-report"';
function enforced(response, label = response.url, upgrade = true) {
  const policy = response.headers.get('content-security-policy');
  const nonce = policy?.match(/'nonce-([A-Za-z0-9+/=]+)'/)?.[1];
  assert.ok(nonce, `${label} carries the enforced nonce policy: ${policy}`);
  assert.equal(policy, enforcedPolicy(nonce, upgrade), `${label} carries exactly one enforced policy`);
  assert.ok(!policy.includes(','), `${label}: the baseline is not joined into the enforced policy`);
  assert.equal(response.headers.get('content-security-policy-report-only'), null, `${label} carries no report-only policy`);
  assert.equal(response.headers.get('reporting-endpoints'), reportingEndpoints, `${label} names the CSP report endpoint`);
  return nonce;
}
function bypassed(response, label = response.url) {
  assert.equal(response.headers.get('content-security-policy'), baselinePolicy, `${label} keeps exactly the next.config.ts baseline`);
  assert.equal(response.headers.get('content-security-policy-report-only'), null, `${label} carries no report-only policy`);
  assert.equal(response.headers.get('reporting-endpoints'), null, `${label} carries no Reporting-Endpoints header`);
}
// Headers every response carries; the CSP depends on whether the proxy ran.
// Returns the response nonce for proxied responses.
function securityHeaders(response, referrerPolicy, { proxied = true } = {}) {
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), referrerPolicy);
  assert.equal(response.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  assert.doesNotMatch(response.headers.get('content-security-policy') ?? '', /chatgpt\.com/i, 'the portal does not allow external framing');
  if (proxied) return enforced(response);
  bypassed(response);
}
const referrerFor = pathname => /^\/(?:api|downloads)(?:\/|$)/.test(pathname) ? 'no-referrer' : 'strict-origin-when-cross-origin';
async function noncedPage(pathname, extra, status = 200) {
  const response = await call(pathname, undefined, extra);
  assert.equal(response.status, status, pathname);
  assert.match(response.headers.get('content-type') ?? '', /^text\/html/, `${pathname} returns HTML`);
  const nonce = securityHeaders(response, referrerFor(pathname));
  const body = await response.text();
  const scripts = body.match(/<script\b[^>]*>/g) ?? [];
  assert.ok(scripts.length > 0, `${pathname} renders scripts`);
  for (const tag of scripts) assert.ok(tag.includes(`nonce="${nonce}"`), `${pathname} script carries the request nonce: ${tag}`);
  return { nonce, body, headers: JSON.stringify([...response.headers]) };
}

// One node child process in this tree; resolves with its standard output.
function node(args, env = configuration) {
  return new Promise((resolve, reject) => {
    const runner = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    runner.stdout.on('data', value => { out += value; });
    runner.stderr.on('data', value => { err += value; });
    runner.on('error', reject);
    runner.on('close', code => code === 0 ? resolve(out) : reject(new Error(`node ${args.join(' ')} ended with ${code}: ${err}`)));
  });
}

async function startServer(env, serverPort) {
  child = spawn(process.execPath, ['--import', './runtime/startup.mjs', '.next/standalone/server.js'], { env: { ...env, HOSTNAME: '127.0.0.1', PORT: String(serverPort) }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', value => { output = (output + value).slice(-16_000); });
  child.on('error', error => { output += error.message; });
  const deadline = Date.now() + 60_000;
  while (true) {
    try { if ((await fetch(`http://127.0.0.1:${serverPort}/api/health/live`)).ok) break; } catch { /* wait for binding */ }
    if (child.exitCode !== null || Date.now() > deadline) throw new Error('Next failed to start: ' + output);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}
async function stopServer() {
  if (!child || child.exitCode !== null) return;
  const finished = new Promise(resolve => child.once('exit', resolve));
  child.kill();
  await finished;
}

try {
  await prepareStandalone();
  // A prerendered page would ship inline scripts without the per-request
  // nonce; the root layout makes the 404 page and every page dynamic.
  const { routes: prerendered } = JSON.parse(await readFile('.next/prerender-manifest.json', 'utf8'));
  for (const route of ['/_not-found', '/remote-desktop', '/']) assert.equal(route in prerendered, false, `${route} is rendered per request, not prerendered`);
  await startServer(configuration, port);
  assert.equal((await call('/api/health/ready')).status, 503, 'unmigrated database cannot become ready');
  await migrateDatabase(database);
  // The real migration gives audit rows their customer.
  assert.ok(await database.one(sql`SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='audit' AND column_name='customer_id'`), 'audit has customer_id after migrate');
  // The migration creates the one usage data row.
  assert.equal(await database.one(sql`SELECT count(*) AS n FROM usage_data`).then(row=>row===null?null:row.n), 1, 'usage_data has one row after migrate');
  const owner = await bootstrapOwner(database, { username: 'admin', displayName: 'Test Owner', origin: configuration.SITE_ORIGIN, env: configuration });
  assert.equal((await call('/api/health/ready')).status, 200);
  const page = await call('/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Nodiverna/);
  securityHeaders(page, 'strict-origin-when-cross-origin');
  const first = await noncedPage('/');
  const nonces = new Set([first.nonce, (await noncedPage('/')).nonce, (await noncedPage('/')).nonce]);
  assert.equal(nonces.size, 3, 'every page request gets a fresh nonce');
  await noncedPage('/remote-desktop');
  // Unknown paths under every prefix render Next's HTML 404 page per request,
  // so its inline scripts carry the nonce of the enforced policy.
  const missing = ['/does-not-exist', '/does-not-exist.html', '/api/does-not-exist', '/downloads/missing/nested/path', '/_next/does-not-exist'];
  for (const pathname of missing) {
    const notFound = await noncedPage(pathname, undefined, 404);
    assert.match(notFound.body, /This page could not be found/, `${pathname} keeps Next's built-in 404 page`);
  }
  // Client CSP request headers cannot choose the nonce on any path.
  const attacker = { 'Content-Security-Policy': "script-src 'nonce-attacker'", 'Content-Security-Policy-Report-Only': "script-src 'nonce-attacker'" };
  for (const [pathname, status] of [['/', 200], ['/does-not-exist', 404], ['/does-not-exist.html', 404], ['/api/does-not-exist', 404]]) {
    const spoofed = await noncedPage(pathname, attacker, status);
    assert.doesNotMatch(spoofed.headers, /attacker/, `${pathname}: client CSP request headers cannot choose the nonce`);
    assert.doesNotMatch(spoofed.body, /attacker/, `${pathname}: client CSP request headers cannot reach the rendered scripts`);
  }
  // A 500 that escapes the app renderer: an RSC request with an unparsable
  // router state tree fails before rendering starts. Rendering the error page
  // for it fails the same way, and this app-only build has no pages/_document
  // to render pages/500.html with, so Next ends with its plain-text answer.
  // That is no document, so there are no scripts a nonce could be missing on.
  const failed = await call('/', undefined, { RSC: '1', 'Next-Router-State-Tree': 'not-json' });
  assert.equal(failed.status, 500, 'invalid router state tree escapes the renderer');
  assert.match(failed.headers.get('content-type') ?? '', /^text\/plain/);
  securityHeaders(failed, 'strict-origin-when-cross-origin');
  assert.equal(await failed.text(), 'Internal Server Error');
  // The build-time error document itself (/_global-error, also copied to
  // pages/500.html) is served from the prerender cache when requested
  // directly. It gets the enforced policy, but its scripts cannot carry a
  // per-request nonce, so the browser blocks them. Its message and reload
  // form are server HTML and work without JavaScript.
  const staticError = await call('/_global-error');
  assert.equal(staticError.status, 500, 'the static error document answers 500');
  assert.match(staticError.headers.get('content-type') ?? '', /^text\/html/);
  securityHeaders(staticError, 'strict-origin-when-cross-origin');
  const staticErrorBody = await staticError.text();
  assert.equal(staticErrorBody, await readFile('.next/server/app/_global-error.html', 'utf8'), 'the build-time static fallback is served unchanged');
  assert.match(staticErrorBody, /<h[12]\b[^>]*>[^<]*\w[^<]*<\/h[12]>/, 'the error message is in the server HTML and readable without scripts');
  const staticErrorScripts = staticErrorBody.match(/<script\b[^>]*>/g) ?? [];
  assert.ok(staticErrorScripts.length > 0, 'the static error document has scripts');
  for (const tag of staticErrorScripts) assert.doesNotMatch(tag, /\bnonce=/, `the build-time static fallback carries no per-request nonce: ${tag}`);
  // Public files run through the proxy too; only build assets bypass it.
  const favicon = await call('/favicon.svg');
  assert.equal(favicon.status, 200);
  securityHeaders(favicon, 'strict-origin-when-cross-origin');
  await favicon.body?.cancel();
  const asset = first.body.match(/src="(\/_next\/static\/[^"]+\.js)"/)?.[1];
  assert.ok(asset, 'page references a build script');
  for (const [pathname, status] of [[asset, 200], ['/_next/static/missing.js', 404]]) {
    const response = await call(pathname);
    assert.equal(response.status, status, pathname);
    securityHeaders(response, 'strict-origin-when-cross-origin', { proxied: false });
    if (status === 404) {
      assert.match(response.headers.get('content-type') ?? '', /^text\/plain/, 'a missing build asset is plain text, never HTML');
      assert.equal(await response.text(), 'Not Found');
    } else await response.body?.cancel();
  }
  // Headers of a former hosting gateway (names built from parts) and a spoofed
  // internal client address authenticate nobody.
  const gateway = ['oai', 'authenticated', 'user'].join('-');
  const spoofed = { [gateway + '-email']: 'owner@example.test', [gateway + '-id']: 'spoofed', 'X-ServerDesk-Client-IP': '203.0.113.42' };
  const anonymous = await call('/api/console', undefined, spoofed);
  assert.equal(anonymous.status, 401, 'gateway identity headers cannot bypass local login');
  securityHeaders(anonymous, 'no-referrer');
  assert.equal(anonymous.headers.get('cache-control'), 'no-store');
  // The branding image routes keep their own Cache-Control through the real server:
  // next.config.ts must not replace it with the /api no-store rule. Without an
  // uploaded icon the favicon redirects with no-cache, a missing logo answers
  // 404 with no-store, and the branding state stays no-store.
  const tabIcon = await fetch(origin + '/api/branding/favicon', { redirect: 'manual' });
  assert.equal(tabIcon.status, 307, 'no uploaded icon: favicon redirects');
  assert.equal(tabIcon.headers.get('location'), '/favicon.svg');
  assert.equal(tabIcon.headers.get('cache-control'), 'no-cache', 'the favicon route sets its own Cache-Control');
  assert.equal(tabIcon.headers.get('referrer-policy'), 'no-referrer');
  const missingLogo = await fetch(origin + '/api/branding/portal/light');
  assert.equal(missingLogo.status, 404);
  assert.equal(missingLogo.headers.get('cache-control'), 'no-store', 'an error answer of an image route is not cached');
  await missingLogo.body?.cancel();
  const brandingState = await fetch(origin + '/api/branding');
  assert.equal(brandingState.status, 200);
  assert.equal(brandingState.headers.get('cache-control'), 'no-store');
  await brandingState.body?.cancel();
  // The identity status has exactly three fields (Entra sign-in is off on the
  // fresh instance), and the removed account takeover is not handled: spoofed
  // gateway headers change nothing.
  const identityStatus = await call('/api/auth', undefined, spoofed);
  assert.equal(identityStatus.status, 200);
  assert.deepEqual(await identityStatus.json(), { viewer: null, passwordConfigured: false, entra: { enabled: false, entraOnly: false } }, 'the identity status is only viewer, passwordConfigured and the Entra sign-in state');
  const takeover = await call('/api/auth', { action: 'activate', username: 'taken-over', password: 'Takeover-passphrase-' + randomBytes(8).toString('hex') }, spoofed);
  assert.notEqual(takeover.status, 200, 'the removed activation action is not handled');
  await takeover.body?.cancel();
  assert.equal((await call('/api/edition')).status, 404, 'the former license route does not exist');
  assert.equal((await call('/api/usage-data')).status, 401, 'the usage data setting needs a session');
  assert.equal((await call('/api/maintenance')).status, 401, 'the maintenance page needs a session');
  assert.equal((await call('/api/customers')).status, 401, 'the customer list needs a session');
  // Anonymous CSP report sink: no session, MFA or Origin, empty answers, and
  // only the reduced summary reaches the server log.
  const report = (body, type, extra = {}) => fetch(origin + '/api/csp-report', { method: 'POST', body, headers: { 'Content-Type': type, ...extra } });
  const reportLines = () => output.split(/\r?\n/).filter(line => line.startsWith('csp-report {'));
  const waitForLines = async expected => {
    for (let attempt = 0; attempt < 40 && reportLines().length < expected; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
    return reportLines();
  };
  const leakyReport = {
    'document-uri': 'https://portal.test/remote-desktop?secret=query-secret#token=fragment-secret', referrer: 'https://portal.test/?referrer-secret',
    'violated-directive': "script-src-elem 'self'", 'effective-directive': 'script-src-elem', disposition: 'report',
    'original-policy': "script-src 'self' 'nonce-NonceSecret123' 'strict-dynamic'", 'blocked-uri': 'https://evil.example/steal?secret=1',
    'line-number': 3, 'column-number': 9, 'source-file': 'https://portal.test/_next/static/app.js?secret=2', 'status-code': 200,
    'script-sample': 'sampleSecret()',
  };
  // Sample, query, fragment, nonce, referrer, wrapper URL, user agent and request headers never reach the log.
  const leaks = ['sampleSecret', 'query-secret', 'fragment-secret', 'NonceSecret123', 'referrer-secret', 'referrer-agent', 'secret=', 'steal', 'session-header-secret'];
  const firstReport = await report(JSON.stringify({ 'csp-report': leakyReport }), 'application/csp-report', { 'X-ServerDesk-Session': 'session-header-secret' });
  assert.equal(firstReport.status, 204, 'report-uri report accepted without session or Origin');
  assert.equal(await firstReport.text(), '');
  const [firstLine] = await waitForLines(1);
  assert.ok(firstLine, 'report-uri report is logged: ' + output.slice(-2000));
  assert.equal(JSON.parse(firstLine.slice('csp-report '.length)).violations[0].directive, 'script-src-elem');
  assert.equal(JSON.parse(firstLine.slice('csp-report '.length)).violations[0].blocked, 'https://evil.example');
  const apiReport = [{ type: 'csp-violation', age: 1, url: 'https://portal.test/?secret=wrapper', user_agent: 'referrer-agent', body: {
    documentURL: leakyReport['document-uri'], referrer: leakyReport.referrer, blockedURL: 'inline', effectiveDirective: 'script-src-elem',
    originalPolicy: leakyReport['original-policy'], sourceFile: leakyReport['source-file'], sample: leakyReport['script-sample'],
    disposition: 'report', statusCode: 200, lineNumber: 4, columnNumber: 1,
  } }, { type: 'deprecation', age: 1, url: 'https://portal.test/', user_agent: 'x', body: { id: 'secret' } }];
  const secondReport = await report(JSON.stringify(apiReport), 'application/reports+json; charset=utf-8');
  assert.equal(secondReport.status, 204, 'Reporting API batch accepted');
  assert.equal(await secondReport.text(), '');
  const lines = await waitForLines(2);
  assert.equal(lines.length, 2, 'each accepted report request writes one line');
  assert.deepEqual(JSON.parse(lines[1].slice('csp-report '.length)), { count: 1, violations: [{ directive: 'script-src-elem', blocked: 'inline', document: 'https://portal.test/remote-desktop', source: 'https://portal.test/_next/static/app.js', line: 4, column: 1, disposition: 'report', status: 200 }] });
  for (const leak of leaks) assert.ok(!output.includes(leak), `server log leaks ${leak}`);
  for (const line of lines) assert.doesNotMatch(line, /secret|nonce|referrer|sample|policy|127\.0\.0\.1/i, 'report lines hold only reduced fields');
  assert.equal((await report('{}', 'text/plain')).status, 415, 'other content types are rejected');
  assert.equal((await report('x'.repeat(17_000), 'application/csp-report')).status, 413, 'oversized reports are rejected');
  assert.equal((await report('[1]', 'application/reports+json')).status, 400, 'other JSON shapes are rejected');
  // Last report calls: without a trusted ingress header all clients share
  // one bucket. The proxy deletes a spoofed X-ServerDesk-Client-IP, so it cannot
  // get past the rate limit.
  const statuses = [];
  for (let index = 0; index < 21; index++) statuses.push((await report(JSON.stringify({ 'csp-report': { 'effective-directive': 'connect-src' } }), 'application/csp-report', { 'X-ServerDesk-Client-IP': `198.51.100.${index}` })).status);
  const limited = statuses.indexOf(429);
  assert.ok(limited > 0, 'spoofed client IPs share the unknown-ingress bucket: ' + statuses.join(','));
  assert.ok(statuses.slice(limited).every(status => status === 429), 'once limited, the window stays closed: ' + statuses.join(','));
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(reportLines().length, 2 + limited, 'rate-limited reports write no log line');
  const token = new URLSearchParams(new URL(owner.invitationUrl).hash.slice(1)).get('invite');
  const password = 'Integration-passphrase-' + randomBytes(20).toString('hex');
  assert.equal((await call('/api/auth', { action: 'redeem', token, username: 'admin', password }, { Origin: 'https://other.invalid' })).status, 403, 'cross-origin writes rejected');
  const redeemed = await call('/api/auth', { action: 'redeem', token, username: 'admin', password });
  assert.match(redeemed.headers.get('set-cookie'), /__Host-serverdesk-auth=.*Secure; HttpOnly/);
  strictSessionCookies(redeemed, 'redeem');
  assert.ok(jar.has('__Host-serverdesk-auth'), 'the primary session arrives as a cookie');
  await accepted(redeemed, 'owner redeems invitation');
  assert.equal((await call('/api/auth', { action: 'redeem', token, username: 'admin', password })).status, 400, 'invitation is one-use');
  assert.equal((await call('/api/console')).status, 403, 'password alone never grants portal access');
  const setup = await accepted(await call('/api/mfa', { action: 'begin' }), 'begin TOTP');
  const confirmResponse = await call('/api/mfa', { action: 'confirm', code: fixtureTotp(setup.secret) });
  strictSessionCookies(confirmResponse, 'confirm');
  assert.ok(jar.has('__Host-serverdesk-mfa'), 'the MFA session arrives as a cookie');
  const confirmed = await accepted(confirmResponse, 'confirm real TOTP');
  assert.equal(confirmed.recoveryCodes.length, 10);
  const consoleState = await accepted(await call('/api/console'), 'authenticated owner portal');
  // Headers never authenticate: the jar's own valid tokens, sent only as headers, are refused.
  const headerOnly = await fetch(origin + '/api/console', { headers: { Origin: configuration.SITE_ORIGIN, 'X-ServerDesk-Session': jar.get('__Host-serverdesk-auth'), 'X-ServerDesk-Mfa': jar.get('__Host-serverdesk-mfa') } });
  assert.equal(headerOnly.status, 401, 'GET /api/console with header-only tokens is refused');
  assert.equal((await headerOnly.json()).code, 'IDENTITY_LOGIN_REQUIRED', 'header-only tokens count as no token');
  assert.ok(consoleState.viewer.permissions.includes('*'), 'the bootstrap Owner holds *');
  assert.deepEqual(['role', 'provider'].filter(key => key in consoleState.viewer), [], 'the viewer has no compatibility role and no provider');
  assert.deepEqual(Object.keys(consoleState.auth).sort(), ['mode', 'origin'], 'the console auth block has no shared users or access requests');
  assert.deepEqual(consoleState.servers, []);
  const rbacState = await accepted(await call('/api/rbac'), 'RBAC roles available');
  assert.deepEqual(rbacState.permissions.find(permission => permission.id === crossCustomerPermission), { id: crossCustomerPermission, labelKey: crossCustomerPermissionLabelKey }, 'GET /api/rbac lists the cross-customer right with its catalog key');
  // There is one edition: the former license route does not exist.
  assert.equal((await call('/api/edition')).status, 404, 'GET /api/edition answers 404');
  assert.equal((await call('/api/edition', { action: 'start-trial' })).status, 404, 'POST /api/edition answers 404');
  // The Owner reads the usage data decision in the real build. Usage data is off in this version: a change is refused.
  const usageResponse = await call('/api/usage-data');
  assert.equal(usageResponse.headers.get('cache-control'), 'no-store');
  const usage = await accepted(usageResponse, 'owner usage data');
  const portalVersion = JSON.parse(await readFile('package.json', 'utf8')).version;
  assert.deepEqual([Object.keys(usage)[0], usage.enabled, usage.consent, usage.server, usage.payload.version], ['enabled', false, null, 'none', portalVersion], 'off, undecided, no usage data server, the version of package.json');
  assert.deepEqual(Object.keys(usage.payload), ['schema', 'instanceId', 'version', 'deviceCount'], 'the payload has exactly four keys');
  assert.equal('decidedBy' in usage, false, 'the deciding account stays on the server');
  const declined = await call('/api/usage-data', { action: 'set', enabled: false, revision: usage.revision });
  assert.deepEqual([declined.status, (await declined.json()).code], [409, 'CONFLICT'], 'off: the owner cannot change the decision');
  const unchanged = await accepted(await call('/api/usage-data'), 'owner usage data after the refusal');
  assert.deepEqual([unchanged.consent, unchanged.revision], [null, usage.revision], 'nothing was written');
  // The page Settings → Maintenance in the real build: GET, Run now, and 403 for an account that lost the Owner right.
  const maintenanceResponse = await call('/api/maintenance');
  assert.equal(maintenanceResponse.headers.get('cache-control'), 'no-store');
  const maintenanceView = await accepted(maintenanceResponse, 'owner maintenance view');
  assert.deepEqual(Object.keys(maintenanceView), ['settings', 'envInvalid', 'status', 'history', 'storage', 'areaRetention', 'customerRetention']);
  assert.deepEqual(maintenanceView.customerRetention, { count: 0, minDays: null, maxDays: null }, 'only the seed customer, without its own audit retention');
  assert.ok(typeof maintenanceView.storage.databaseBytes === 'number' && maintenanceView.storage.databaseBytes > 0, 'the database size is a positive number');
  assert.deepEqual(maintenanceView.settings, { auditDays: 30, jobDays: 30, runAt: '03:00', timeZone: 'UTC', revision: 0, source: { auditDays: 'default', jobDays: 'default' } });
  assert.deepEqual([maintenanceView.history, maintenanceView.status.lastRun, maintenanceView.status.nextRunAt], [[], null, null], 'no run yet; no next run while the scheduler is off');
  const started = await call('/api/maintenance', { action: 'run' });
  assert.equal(started.status, 202, 'Run now answers 202');
  const { runId } = await started.json();
  let finishedRun;
  for (let attempt = 0; attempt < 100 && !finishedRun; attempt++) {
    const row = await database.one(sql`SELECT id,status,trigger,requested_by FROM maintenance_runs WHERE id=${runId}`);
    if (row && row.status !== 'running') finishedRun = row;
    else await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.deepEqual(finishedRun, { id: runId, status: 'succeeded', trigger: 'manual', requested_by: owner.userId + '@local.serverdesk.invalid' }, 'the run finished in the server process after the reply; requested_by is the account label');
  const ownerAssignments = await database.query(sql`SELECT * FROM role_assignments WHERE principal_id=${owner.userId}`);
  await database.exec(sql`DELETE FROM role_assignments WHERE principal_id=${owner.userId}`);
  const demotedView = await call('/api/maintenance');
  assert.equal(demotedView.status, 403, 'a non-Owner gets 403');
  assert.equal((await demotedView.json()).code, 'MAINTENANCE_OWNER_ONLY');
  for (const row of ownerAssignments) await database.exec(sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(${row.id},${row.principal_type},${row.principal_id},${row.role_id},${row.scope_type},${row.scope_id},${row.created_at},${row.created_by})`);
  assert.equal((await call('/api/maintenance')).status, 200, 'the restored Owner reads it again');
  // Owners see the customers and the setting "Multiple customers", no license.
  const customersResponse = await call('/api/customers');
  assert.equal(customersResponse.headers.get('cache-control'), 'no-store');
  const customerList = await accepted(customersResponse, 'owner customer list');
  assert.equal('edition' in customerList, false, 'the answer has no edition field');
  assert.equal(customerList.customers.length, 1, 'exactly the first customer');
  assert.deepEqual(customerList.multipleCustomers, { enabled: false, otherCustomers: 0, revision: 0 }, 'a new portal starts with multiple customers off');
  assert.deepEqual({ ...customerList.customers[0], createdAt: 0, updatedAt: 0 }, { id: '00000000-0000-4000-8000-000000000100', name: 'Standardkunde', status: 'active', contactName: '', contactEmail: '', contactPhone: '', createdAt: 0, updatedAt: 0, auditRetentionDays: null, maintenanceWindow: null, revision: 0, deviceCount: 0, groupCount: 0, runbookCount: 0, templateCount: 0, roleCount: 0 });
  // A new portal has "Multiple customers" off: create needs no MFA confirmation, and the setting refuses it.
  const lockedCreate = await call('/api/customers', { action: 'create', name: 'Test' });
  assert.equal(lockedCreate.status, 409, 'a new portal creates no second customer while multiple customers is off');
  assert.equal(lockedCreate.headers.get('cache-control'), 'no-store');
  assert.equal((await lockedCreate.json()).code, 'MULTIPLE_CUSTOMERS_OFF', 'with the code of the setting');
  const unknownCustomerAction = await call('/api/customers', { action: 'merge' });
  assert.equal(unknownCustomerAction.status, 400, 'unknown customer actions are rejected');
  assert.equal((await unknownCustomerAction.json()).error, serverText('apiError.customer.unknownAction'));
  assert.equal((await call('/api/customers', { action: 'create', name: 'Test' }, { Origin: 'https://other.invalid' })).status, 403, 'cross-origin customer writes are rejected');
  // Deleting a customer needs an MFA confirmation before anything else is checked.
  const lockedDelete = await call('/api/customers', { action: 'delete', id: '00000000-0000-4000-8000-000000000100', revision: 0 });
  assert.equal(lockedDelete.status, 403, 'deleting a customer needs an MFA confirmation');
  assert.equal(lockedDelete.headers.get('cache-control'), 'no-store');
  assert.match((await lockedDelete.json()).code, /^MFA_(?:STEP_UP|LOGIN)_REQUIRED$/, 'with an MFA code');
  assert.equal(await database.one(sql`SELECT count(*) AS n FROM customers`).then(row=>row===null?null:row.n), 1, 'no customer was written');
  // The Owner also reads the assignable technicians; assigning them needs an MFA confirmation.
  assert.ok(Array.isArray(customerList.technicians.users) && Array.isArray(customerList.technicians.groups), 'the customer list carries the technicians');
  assert.deepEqual(Object.keys(customerList.technicians.users[0]).sort(), ['email', 'id', 'label', 'owner', 'status'], 'technician users have their fields');
  assert.equal(customerList.technicians.users.some(user => user.owner === true), true, 'the bootstrap Owner is marked');
  assert.deepEqual(customerList.assignments, [], 'no assignments in a fresh portal');
  const lockedTechnicians = await call('/api/customers', { action: 'set-technicians', id: '00000000-0000-4000-8000-000000000100', revision: 0, userIds: [], groupIds: [] });
  assert.equal(lockedTechnicians.status, 403, 'assigning technicians needs an MFA confirmation');
  assert.equal(lockedTechnicians.headers.get('cache-control'), 'no-store');
  assert.match((await lockedTechnicians.json()).code, /^MFA_(?:STEP_UP|LOGIN)_REQUIRED$/, 'with an MFA code');
  assert.equal(await database.one(sql`SELECT count(*) AS n FROM customer_assignments`).then(row=>row===null?null:row.n), 0, 'no assignment was written');
  // Installers: the list is empty, the device groups come along, and
  // creating one needs the portal prerequisites and an MFA confirmation.
  assert.deepEqual(customerList.installers, [], 'no installers in a fresh portal');
  assert.ok(Array.isArray(customerList.deviceGroups), 'the customer list carries the device groups');
  const lockedInstaller = await call('/api/customers', { action: 'create-installer', customerId: '00000000-0000-4000-8000-000000000100', name: 'Rollout', groupId: null, mode: 'ReadOnly', validDays: 30, maxDevices: null });
  assert.notEqual(lockedInstaller.status, 200, 'creating an installer without MFA confirmation is refused');
  assert.equal(lockedInstaller.headers.get('cache-control'), 'no-store');
  assert.equal(await database.one(sql`SELECT count(*) AS n FROM customer_installers`).then(row=>row===null?null:row.n), 0, 'no installer was written');
  // The enrollment endpoint needs no session: an unknown key is 403, not 401, and
  // a request that names a customer is refused. Neither creates a device.
  const serversBeforeEnroll = await database.one(sql`SELECT count(*) AS n FROM servers`).then(row=>row===null?null:row.n);
  const enrollRequest = payload => fetch(origin + '/api/agent/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const unknownInstaller = await enrollRequest({ installerKey: randomBytes(32).toString('hex'), name: 'HTTP-Installer' });
  assert.equal(unknownInstaller.status, 403, 'an unknown installer key is refused without a session');
  assert.equal(unknownInstaller.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await unknownInstaller.json(), { error: serverText('apiError.installer.invalid'), code: 'INSTALLER_INVALID', messageKey: 'apiError.installer.invalid' });
  const namedCustomer = await enrollRequest({ installerKey: randomBytes(32).toString('hex'), name: 'HTTP-Installer', customerId: '00000000-0000-4000-8000-000000000100' });
  assert.equal(namedCustomer.status, 400, 'a request may not name a customer');
  assert.equal((await namedCustomer.json()).error, serverText('apiError.installer.invalidRequest'));
  assert.equal(await database.one(sql`SELECT count(*) AS n FROM servers`).then(row=>row===null?null:row.n), serversBeforeEnroll, 'no device from a refused enrollment');
  // Exercise the actual deployed routes, session/MFA admissions and the
  // database migrations together; the fixture database is removed after this test.
  let recoveryCodes = [...confirmed.recoveryCodes];
  const management = async () => {
    // Reserve one real recovery code to rotate the finite set through the
    // authenticated HTTP route; every group change still gets a one-use proof.
    if (recoveryCodes.length === 1) {
      const rotation = await accepted(await call('/api/mfa', { action: 'verify', recoveryCode: recoveryCodes.shift() }), 'recovery rotation step-up');
      const renewed = await accepted(await call('/api/mfa', { action: 'regenerate-recovery', managementToken: rotation.managementToken }), 'renew fixture recovery codes');
      assert.equal(renewed.recoveryCodes.length, 10);
      recoveryCodes = [...renewed.recoveryCodes];
    }
    return (await accepted(await call('/api/mfa', { action: 'verify', recoveryCode: recoveryCodes.shift() }), 'management step-up')).managementToken;
  };
  // A personal registration needs a fresh step-up proof from a real verify.
  const enrollment = await accepted(await call('/api/console', { action: 'enroll', name: 'HTTP Test Device', management: false, managementToken: await management() }), 'register device');
  assert.ok(enrollment.id && enrollment.token, 'registration yields a device credential');
  const firstCustomer = '00000000-0000-4000-8000-000000000100';
  const customerOf = async (table, id) => (await database.one(sql`SELECT customer_id FROM ${sql.ident(table)} WHERE id=${id}`))?.customer_id;
  assert.equal(await customerOf('servers', enrollment.id), firstCustomer, 'a device enrolled without a group belongs to the first customer');
  const hierarchy = [];
  for (let depth = 0; depth <= 4; depth++) {
    // Organizing devices is routine (lib/step-up.ts): the MFA login session suffices.
    const group = await accepted(await call('/api/access', { action: 'create-group', name: 'HTTP Group ' + depth, parentId: hierarchy.at(-1) ?? null }), 'create group level ' + depth + ' without step-up');
    hierarchy.push(group.id);
  }
  await accepted(await call('/api/access', { action: 'update-group', id: hierarchy[0], name: 'HTTP Group 0', description: 'Ohne erneute MFA' }), 'rename a group without step-up');
  assert.equal(await customerOf('device_groups', hierarchy[0]), firstCustomer, 'a root group belongs to the first customer');
  assert.equal(await customerOf('device_groups', hierarchy[1]), firstCustomer, 'a subgroup inherits its parent customer');
  const groupedEnrollment = await accepted(await call('/api/console', { action: 'enroll', name: 'HTTP Grouped Device', management: false, groupId: hierarchy[1], managementToken: await management() }), 'register device into a subgroup');
  assert.equal(await customerOf('servers', groupedEnrollment.id), firstCustomer, 'a device enrolled into a group gets that group customer');
  assert.equal((await database.one(sql`SELECT group_id FROM device_group_members WHERE server_id=${groupedEnrollment.id}`))?.group_id, hierarchy[1]);
  const customerFields = /customer_?id/i;
  // Devices, groups and permission targets carry their customer so the catalogs
  // can filter targets and the tree can build customer folders; no other console field names a customer.
  const consoleCustomers = await accepted(await call('/api/console'), 'console customer fields');
  assert.ok(consoleCustomers.servers.length && consoleCustomers.servers.every(server => server.customerId === firstCustomer), 'GET /api/console names the customer of every device');
  assert.ok(consoleCustomers.deviceGroups.length, 'GET /api/console lists the created groups');
  assert.ok(consoleCustomers.deviceGroups.every(group => group.customerId === firstCustomer), 'GET /api/console names the customer of every group');
  if (Object.hasOwn(consoleCustomers, 'permissionDevices')) {
    assert.ok(consoleCustomers.permissionDevices.length, 'GET /api/console lists permission targets');
    assert.ok(consoleCustomers.permissionDevices.every(target => target.customerId === firstCustomer), 'GET /api/console names the customer of every permission target');
  }
  // Audit rows name their customer (customerId, customerName) as well.
  const withoutCustomer = rows => rows.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => !['customerId', 'customerName'].includes(key))));
  assert.ok(consoleCustomers.audit.every(entry => 'customerId' in entry && 'customerName' in entry), 'audit rows carry customerId and customerName');
  assert.doesNotMatch(JSON.stringify({ ...consoleCustomers, servers: withoutCustomer(consoleCustomers.servers), audit: withoutCustomer(consoleCustomers.audit), deviceAudit: withoutCustomer(consoleCustomers.deviceAudit ?? []), deviceGroups: withoutCustomer(consoleCustomers.deviceGroups), permissionDevices: withoutCustomer(consoleCustomers.permissionDevices ?? []) }), customerFields, 'GET /api/console exposes no other customer field');
  assert.doesNotMatch(JSON.stringify(await accepted(await call('/api/access'), 'access without customer fields')), customerFields, 'GET /api/access exposes no customer field yet');
  // Both lists name the customers the viewer sees, here exactly the first one.
  assert.deepEqual((await accepted(await call('/api/console'), 'console customers')).customers, [{ id: firstCustomer, name: 'Standardkunde' }], 'GET /api/console lists the visible customers');
  assert.deepEqual((await accepted(await call('/api/access'), 'access customers')).customers, [{ id: firstCustomer, name: 'Standardkunde' }], 'GET /api/access lists the visible customers');
  const chosenRoot = await accepted(await call('/api/access', { action: 'create-group', name: 'HTTP Customer Root', customerId: firstCustomer, managementToken: await management() }), 'root group with the first customer');
  assert.equal(await customerOf('device_groups', chosenRoot.id), firstCustomer, 'the chosen customer owns the root group');
  const unknownCustomer = await call('/api/access', { action: 'create-group', name: 'HTTP Unknown Customer', customerId: '00000000-0000-4000-8000-0000000009ff', managementToken: await management() });
  assert.equal(unknownCustomer.status, 404, 'an unknown customer is refused');
  assert.equal(await database.one(sql`SELECT count(*) AS n FROM device_groups WHERE name='HTTP Unknown Customer'`).then(row=>row===null?null:row.n), 0, 'no group for an unknown customer');
  assert.equal((await call('/api/access', { action: 'delete-group', id: chosenRoot.id, confirm: true, managementToken: await management() })).status, 200, 'the extra root group is removed again');
  assert.equal((await call('/api/access', { action: 'create-group', name: 'Too deep', parentId: hierarchy.at(-1), managementToken: await management() })).status, 409, 'fifth subgroup is rejected by the actual HTTP route');
  await accepted(await call('/api/access', { action: 'set-device-memberships', groupId: hierarchy[0], serverIds: [enrollment.id], assigned: true }), 'initial parent membership without step-up');
  await accepted(await call('/api/access', { action: 'set-device-memberships', groupId: hierarchy.at(-1), serverIds: [enrollment.id], assigned: true, managementToken: await management() }), 'move direct membership to child, a supplied token is ignored');
  const inheritedDevice = (await accepted(await call('/api/console'), 'hierarchical console')).servers.find(device => device.id === enrollment.id);
  assert.equal(inheritedDevice.groups.length, 5, 'console returns every ancestor once');
  assert.equal(inheritedDevice.groups.filter(group => group.direct).length, 1, 'console distinguishes direct membership from inherited groups');
  assert.equal(inheritedDevice.groups.find(group => group.direct).id, hierarchy.at(-1), 'child replaces the direct parent membership');
  const independent = await accepted(await call('/api/access', { action: 'create-group', name: 'HTTP Independent', parentId: null, managementToken: await management() }), 'independent root');
  await accepted(await call('/api/access', { action: 'set-device-memberships', groupId: independent.id, serverIds: [enrollment.id], assigned: true, managementToken: await management() }), 'independent membership');
  // Since migration 0027 a device has exactly one group; assigning it elsewhere moves it, also across branches.
  const deviceGroups = async () => (await accepted(await call('/api/console'), 'moved console')).servers.find(server => server.id === enrollment.id).groups;
  const directGroups = async () => (await deviceGroups()).filter(group => group.direct).map(group => group.id).sort();
  const storedGroups = async () => (await database.query(sql`SELECT group_id FROM device_group_members WHERE server_id=${enrollment.id}`)).map(row => row.group_id);
  assert.deepEqual(await directGroups(), [independent.id], 'assigning to another branch moves the device into the independent root');
  assert.deepEqual((await deviceGroups()).map(group => group.id), [independent.id], 'the independent root has no ancestors and no hierarchy group remains');
  assert.deepEqual(await storedGroups(), [independent.id], 'the database keeps exactly one membership row after the move to the independent root');
  await accepted(await call('/api/access', { action: 'update-device-memberships', groupId: hierarchy[0], addIds: [enrollment.id], removeIds: [], managementToken: await management() }), 'move independent back to parent');
  assert.deepEqual(await directGroups(), [hierarchy[0]], 'moving to the parent takes the device out of the independent root instead of keeping it');
  assert.deepEqual(await storedGroups(), [hierarchy[0]], 'the database keeps exactly one membership row after the move to the parent');
  await accepted(await call('/api/access', { action: 'update-device-memberships', groupId: hierarchy.at(-1), addIds: [enrollment.id], removeIds: [], managementToken: await management() }), 'move parent back to child');
  assert.deepEqual(await directGroups(), [hierarchy.at(-1)], 'moving to a child replaces the parent membership');
  const childGroups = (await deviceGroups()).map(group => group.id);
  assert.equal(childGroups.length, 5, 'the child membership again inherits every ancestor once');
  assert.equal(childGroups.includes(independent.id), false, 'the independent root is no longer among the device groups');
  assert.deepEqual(await storedGroups(), [hierarchy.at(-1)], 'the database keeps exactly one membership row after the move to the child');
  assert.equal((await call('/api/access', { action: 'delete-group', id: hierarchy[0], confirm: true, managementToken: await management() })).status, 409, 'parent deletion cannot orphan subgroups');
  const configId = randomUUID(), versionId = randomUUID(), at = Date.now();
  const principal = (await database.one(sql`SELECT auth_principal FROM local_users WHERE username='admin'`)).auth_principal;
  await database.transaction(async tx => {
    await tx.exec(sql`INSERT INTO desired_configs(id,name,description,created_by,created_at) VALUES(${configId},'HTTP Desired','',${principal},${at})`);
    await tx.exec(sql`INSERT INTO desired_versions(id,config_id,version,engine,content,sha256,created_by,created_at) VALUES(${versionId},${configId},1,'dsc-v3-json','{}',${createHash('sha256').update('{}').digest('hex')},${principal},${at})`);
  });
  assert.equal((await call('/api/automation', { action: 'create-template', kind: 'invalid', name: 'Invalid' })).status, 400, 'invalid input is a client error');
  const template = await accepted(await call('/api/automation', { action: 'create-template', kind: 'desired', name: 'HTTP Desired template', versionId, intervalSeconds: 0 }), 'create central desired template');
  assert.equal((await call('/api/automation', { action: 'assign', templateId: template.id, scopeType: 'group', scopeId: hierarchy[0] })).status, 400, 'central assignment requires explicit confirmation');
  const assignment = await accepted(await call('/api/automation', { action: 'assign', templateId: template.id, scopeType: 'group', scopeId: hierarchy[0], confirm: true }), 'assign central template to parent');
  const catalog = await accepted(await call('/api/automation'), 'central automation catalog');
  assert.equal(catalog.assignments.find(value => value.id === assignment.id).scopeId, hierarchy[0]);
  assert.equal(catalog.groups.find(group => group.id === hierarchy.at(-1)).depth, 4);
  await accepted(await call('/api/automation', { action: 'remove-assignment', assignmentId: assignment.id, confirm: true }), 'remove central assignment');
  // An unknown assignment is 404 like one of a foreign customer (no longer ok).
  const missingAssignment = await call('/api/automation', { action: 'remove-assignment', assignmentId: randomUUID(), confirm: true });
  assert.deepEqual([missingAssignment.status, (await missingAssignment.json()).error], [404, serverText('apiError.catalog.assignmentGone')], 'removing an unknown assignment');
  // With only the default customer every catalog reports one shared library.
  for (const pathname of ['/api/runbooks', '/api/automation', '/api/rbac']) {
    const listed = await accepted(await call(pathname), pathname + ' catalog');
    assert.deepEqual({ separated: listed.catalog.separated, libraryWritable: listed.catalog.libraryWritable }, { separated: false, libraryWritable: true }, pathname + ' reports an unseparated catalog');
    assert.deepEqual(listed.catalog.customers, [{ id: firstCustomer, name: 'Standardkunde' }], pathname + ' lists the visible customers');
  }
  assert.equal(catalog.templates.find(value => value.id === template.id).customerId, null, 'a template created with only the default customer is library');
  // Actions on devices of one customer run as before, without the cross-customer gate or warning.
  const singleBook = await accepted(await call('/api/runbooks', { action: 'create-version', name: 'HTTP Einkunden', description: '', definition: { steps: [{ id: 'refresh', name: 'Aktualisieren', kind: 'diagnosis', operation: 'refresh' }], parameters: [] } }), 'library runbook for one customer');
  const singlePreview = await accepted(await call('/api/runbooks', { action: 'dryrun', versionId: singleBook.versionId, targets: [enrollment.id] }), 'single-customer runbook preview');
  assert.equal(singlePreview.warnings.some(warning => warning.key === 'serverMessage.runbook.crossCustomerWarning'), false, 'no cross-customer warning for one customer');
  assert.equal(await database.one(sql`SELECT count(*) AS n FROM audit WHERE server_id IS NULL AND customer_id IS NOT NULL`).then(row=>row===null?null:row.n), 0, 'no customer entries for single-customer work');
  // Agent releases. The image holds no agent: on the fresh portal the bootstrap
  // and the Owner download answer noneAvailable and the catalog is empty.
  const noneAvailable = async (response, label) => {
    assert.equal(response.status, 404, label);
    assert.equal(response.headers.get('cache-control'), 'no-store', label);
    assert.equal((await response.json()).messageKey, 'apiError.release.noneAvailable', label);
  };
  for (const query of ['', '?form=path']) await noneAvailable(await fetch(origin + '/Agent-v3-release.json' + query), `fresh /Agent-v3-release.json${query}`);
  const freshDownload = await call('/api/agent/download');
  securityHeaders(freshDownload, 'no-referrer');
  await noneAvailable(freshDownload, 'fresh /api/agent/download');
  assert.deepEqual((await accepted(await call('/api/releases'), 'fresh release catalog')).releases, [], 'the fresh catalog is empty');
  // A synthetic release of the test publisher, imported offline into the test
  // database and storage by selfhost.mjs import-release as a child process.
  const releaseFolder = path.join(temporary, 'test-release');
  const built = JSON.parse(await node(['scripts/test-publisher.mjs', 'release', '--key', publisherKeyFile, '--out', releaseFolder, '--version', '4.90.0']));
  const imported = JSON.parse(await node(['scripts/selfhost.mjs', 'import-release', releaseFolder]));
  const record = JSON.parse(await readFile(path.join(releaseFolder, built.files.record), 'utf8'));
  assert.deepEqual(imported, { version: '4.90.0', releaseId: record.id, status: 'imported' }, 'import-release imports the test release');
  const releaseFiles = { zip: await readFile(path.join(releaseFolder, built.files.zip)), exe: await readFile(path.join(releaseFolder, built.files.exe)) };
  const signedManifest = JSON.parse(record.manifest);
  const catalogAfter = await accepted(await call('/api/releases'), 'release catalog after the import');
  assert.deepEqual(catalogAfter.releases.map(item => [item.id, item.version, item.latest, item.active]), [[record.id, '4.90.0', true, true]], 'the imported release is latest');
  // The bootstrap reads the latest release through a 30 s cache per process
  // (lib/server/agent/releases.ts bootstrapLatestRelease): the fresh 404 above stays until
  // it expires, then the imported release is served.
  const bootstrapDeadline = Date.now() + 45_000;
  while ((await fetch(origin + '/Agent-v3-release.json').then(async response => { await response.body?.cancel(); return response.status; })) === 404 && Date.now() < bootstrapDeadline) await new Promise(resolve => setTimeout(resolve, 1000));
  for (const query of ['', '?form=path']) {
    const bootstrap = await fetch(origin + '/Agent-v3-release.json' + query);
    assert.equal(bootstrap.status, 200, `/Agent-v3-release.json${query}`);
    for (const [header, value] of [['cache-control', 'no-store'], ['x-content-type-options', 'nosniff'], ['content-type', 'application/json; charset=utf-8']]) assert.equal(bootstrap.headers.get(header), value, `/Agent-v3-release.json${query} ${header}`);
    const envelope = await bootstrap.json();
    assert.deepEqual(envelope, { manifest: record.manifest, signature: record.signature }, 'the exact signed bytes of the latest release');
    assert.ok(verify('sha256', Buffer.from(envelope.manifest), publisherPublicKey, Buffer.from(envelope.signature, 'base64')), 'the envelope verifies with the test publisher key');
  }
  // Next.js 16.4.6 drops Content-Length from every route handler answer (FORBIDDEN_HEADERS in
  // next/dist/server/send-response.js) and sends the body chunked. The size travels in
  // X-Agent-Size and the manifest; the byte checks below stay exact.
  const download = await call('/api/agent/download');
  securityHeaders(download, 'no-referrer');
  assert.equal(download.status, 200, 'the Owner download streams the EXE of the latest release');
  for (const [header, value] of [['cache-control', 'no-store'], ['content-type', 'application/octet-stream'], ['content-disposition', 'attachment; filename="ServerDesk.Agent.exe"'], ['content-length', null], ['x-agent-version', '4.90.0'], ['x-agent-sha256', signedManifest.exe.sha256], ['x-agent-size', String(signedManifest.exe.size)]]) assert.equal(download.headers.get(header), value, `/api/agent/download ${header}`);
  const hash = createHash('sha256');
  let size = 0;
  for await (const bytes of download.body) { size += bytes.byteLength; hash.update(bytes); }
  assert.deepEqual([size, hash.digest('hex')], [signedManifest.exe.size, signedManifest.exe.sha256], 'the streamed EXE has the signed size and SHA-256');
  // Every path of the manifest: the whole ZIP and EXE and each part, with the exact bytes.
  const served = [[signedManifest.path, releaseFiles.zip], [signedManifest.exe.path, releaseFiles.exe]];
  for (const [entry, bytes] of [[signedManifest, releaseFiles.zip], [signedManifest.exe, releaseFiles.exe]]) (entry.parts ?? []).forEach((part, index) => served.push([part.path, bytes.subarray(index * 20 * 1024 * 1024, Math.min((index + 1) * 20 * 1024 * 1024, bytes.length))]));
  assert.ok(signedManifest.exe.parts.length === 2, 'the test EXE has two parts');
  for (const [pathname, bytes] of served) {
    const file = await call(pathname);
    securityHeaders(file, 'no-referrer');
    assert.equal(file.status, 200, pathname);
    for (const [header, value] of [['content-type', 'application/octet-stream'], ['content-length', null], ['cache-control', 'no-store'], ['x-content-type-options', 'nosniff']]) assert.equal(file.headers.get(header), value, `${pathname} ${header}`);
    assert.ok(Buffer.from(await file.arrayBuffer()).equals(bytes), `${pathname} serves the exact signed bytes`);
  }
  const unknownFile = await call('/downloads/ServerDesk-Agent-9.9.9-win-x64.exe');
  assert.deepEqual([unknownFile.status, (await unknownFile.json()).messageKey], [404, 'apiError.download.fileNotFound'], 'any other path is not found');
  // A device whose agent does not report release-paths (before 4.12.0) gets no deploy.
  await database.exec(sql`UPDATE servers SET management=1,last_seen=${Date.now()},snapshot=${JSON.stringify({ protocolVersion: 3, agentVersion: '4.11.0', mode: 'Management', os: 'Microsoft Windows 11 Pro', agentCapabilities: ['agent-update'] })} WHERE id=${enrollment.id}`);
  const refusedDeploy = await call('/api/releases', { action: 'deploy', releaseId: record.id, serverIds: [enrollment.id], confirm: true });
  const refusedBody = await refusedDeploy.json();
  assert.deepEqual([refusedDeploy.status, refusedBody.messageKey, refusedBody.params], [409, 'apiError.release.legacyFormUnavailable', { name: 'HTTP Test Device' }], 'a device without release-paths is refused');
  assert.equal(await database.one(sql`SELECT count(*) AS n FROM jobs WHERE action='agent-update'`).then(row => row === null ? null : row.n), 0, 'the refused deploy wrote no job');
  // A password login and an MFA verify on cookies only: no token in either body.
  // The first MFA left a live MFA grant in this browser, and with it a password is
  // enough (docs/portal-sessions.md). Without the grant, the login waits for MFA.
  assert.ok(jar.delete('__Host-serverdesk-mfa-grant'), 'the first MFA left an MFA grant cookie');
  const passwordLogin = await call('/api/auth', { action: 'login', username: 'admin', password });
  strictSessionCookies(passwordLogin, 'login');
  const loggedIn = await accepted(passwordLogin, 'password login');
  assert.equal(loggedIn.viewer.username, 'admin');
  assert.equal((await call('/api/console')).status, 403, 'after a password login the portal waits for MFA');
  const verifyResponse = await call('/api/mfa', { action: 'verify', recoveryCode: recoveryCodes.shift() });
  strictSessionCookies(verifyResponse, 'verify');
  await accepted(verifyResponse, 'verify on cookies');
  await accepted(await call('/api/console'), 'portal after the cookie login');
  const activeJar = new Map(jar);
  await accepted(await call('/api/auth', { action: 'logout' }), 'logout');
  assert.equal(jar.has('__Host-serverdesk-auth') || jar.has('__Host-serverdesk-mfa'), false, 'logout clears the session cookies');
  jar = activeJar;
  assert.equal((await call('/api/console')).status, 401, 'logout revokes the stored session, also when its old cookies are sent again');
  // The proxy reads SITE_ORIGIN per request, not at build time: the same
  // standalone build behind a plain http://localhost origin sends the policy
  // without upgrade-insecure-requests.
  await stopServer();
  const plainPort = await freePort();
  // This start runs the scheduler (instrumentation.ts in the standalone build):
  // without a run since the daily time, its first tick 30 s after the start runs one.
  await database.exec(sql`DELETE FROM maintenance_runs`);
  await startServer({ ...configuration, SITE_ORIGIN: `http://localhost:${plainPort}`, MAINTENANCE_SCHEDULER: '' }, plainPort);
  for (const [pathname, status] of [['/', 200], ['/does-not-exist', 404]]) {
    const response = await fetch(`http://localhost:${plainPort}${pathname}`);
    assert.equal(response.status, status, `http origin ${pathname}`);
    enforced(response, `http origin ${pathname}`, false);
    assert.doesNotMatch(response.headers.get('content-security-policy'), /upgrade-insecure-requests/);
    await response.body?.cancel();
  }
  let scheduled = [];
  for (let attempt = 0; attempt < 90; attempt++) {
    scheduled = await database.query(sql`SELECT status,trigger FROM maintenance_runs`);
    if (scheduled.length && scheduled.every(row => row.status !== 'running')) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.deepEqual(scheduled, [{ status: 'succeeded', trigger: 'schedule' }], 'the scheduler of the standalone server ran maintenance once');
  console.log('PASS Node HTTP: readiness, page/API/download security headers, one complete enforced per-request CSP nonce policy on pages, 404 and error pages without a report-only policy, upgrade-insecure-requests only for an https: SITE_ORIGIN read at runtime, anonymous bounded CSP report sink, origin/identity boundary, real TOTP and one-use management proofs, hierarchical groups/checkbox memberships, central automation routes and confirmation, the fresh catalog, the import of a test-signed release and its signed bootstrap, download and files, the refused deploy without release-paths, session revocation, the maintenance page and the scheduler in the standalone server.');
} catch (error) {
  console.error(output);
  throw error;
} finally {
  await stopServer();
  await database.close();
  await target.drop();
  await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
