import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import ts from 'typescript';

// Load the real policy module as JavaScript; it depends only on global crypto.
const source = await readFile(new URL('../../lib/server/csp.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const csp = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
const { contentSecurityPolicy, reportingEndpoints, createNonce, brandingAssetPolicy, isBrandingAssetPath } = csp;

let cases = 0;
async function test(name, run) { await run(); cases++; console.log('PASS ' + name); }

const directives = policy => new Map(policy.split(';').map(part => part.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));
const forbidden = ["'unsafe-inline'", "'unsafe-eval'", "'wasm-unsafe-eval'", '*', 'data:', 'blob:', 'http:', 'https:', 'ws:', 'wss:'];

const httpsPolicy = "base-uri 'self'; object-src 'none'; frame-ancestors 'self'; script-src 'self' 'nonce-abc' 'strict-dynamic'; connect-src 'self'; default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; frame-src 'self'; worker-src 'self'; form-action 'self'; upgrade-insecure-requests; report-uri /api/csp-report; report-to csp-endpoint";
const plainPolicy = httpsPolicy.replace('upgrade-insecure-requests; ', '');
const policies = [['https', contentSecurityPolicy('abc', 'https://portal.test')], ['http', contentSecurityPolicy('abc', 'http://localhost:3000')]];

await test('an https: origin gets the exact complete policy with upgrade-insecure-requests', () => {
  assert.equal(contentSecurityPolicy('abc', 'https://portal.test'), httpsPolicy);
  assert.match(source, /'unsafe-inline'[\s\S]*injected CSS cannot send data elsewhere[\s\S]*export function contentSecurityPolicy/, 'a comment explains the style-src decision');
});

await test('http:, empty and missing origins get the same policy without upgrade-insecure-requests', () => {
  assert.notEqual(plainPolicy, httpsPolicy);
  for (const origin of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000', '', undefined]) {
    assert.equal(contentSecurityPolicy('abc', origin), plainPolicy, `origin ${JSON.stringify(origin)}`);
  }
  assert.equal(contentSecurityPolicy('abc'), plainPolicy, 'the origin argument is optional');
});

await test('upgrade-insecure-requests has no value, appears at most once and no directive appears twice', () => {
  for (const [label, policy] of policies) {
    const parsed = directives(policy);
    assert.equal(policy.split('; ').length, parsed.size, `${label}: no directive appears twice`);
    assert.ok(policy.split('; ').filter(part => part.startsWith('upgrade-insecure-requests')).length <= 1, `${label}: upgrade-insecure-requests at most once`);
  }
  assert.deepEqual(directives(httpsPolicy).get('upgrade-insecure-requests'), []);
  assert.equal(directives(plainPolicy).has('upgrade-insecure-requests'), false);
  assert.deepEqual([...directives(httpsPolicy).keys()].slice(-3), ['upgrade-insecure-requests', 'report-uri', 'report-to'], 'reporting stays last');
});

const fetchDirectives = ['default-src', 'img-src', 'style-src', 'font-src', 'frame-src', 'worker-src', 'form-action'];
await test('the seven directives from 059 allow only the own origin, plus data: images and inline styles', () => {
  const allowedExtra = { 'img-src': ['data:'], 'style-src': ["'unsafe-inline'"] };
  for (const [label, policy] of policies) {
    const parsed = directives(policy);
    for (const name of fetchDirectives) {
      const values = parsed.get(name);
      assert.ok(values, `${label}: ${name} is present`);
      assert.equal(values[0], "'self'", `${label}: ${name} starts with 'self'`);
      assert.deepEqual(values.slice(1), allowedExtra[name] ?? [], `${label}: ${name} has no other source than 'self'${allowedExtra[name] ? ' and ' + allowedExtra[name].join(' ') : ''}`);
    }
    for (const [name, values] of parsed) {
      for (const value of values) {
        assert.ok(!["'unsafe-eval'", '*', 'blob:', 'http:', 'https:', 'ws:', 'wss:'].includes(value), `${label}: ${name} must not contain ${value}`);
        if (!['report-uri', 'report-to'].includes(name) && value !== 'data:') assert.match(value, /^'[^']+'$/, `${label}: ${name} source ${value} is a quoted keyword, never a host`);
      }
    }
    assert.equal(parsed.get('style-src').some(value => value.startsWith("'nonce-")), false, "style-src has no nonce, it would switch 'unsafe-inline' off");
  }
});

await test('violations go to the report endpoint through report-uri and report-to', () => {
  const parsed = directives(httpsPolicy);
  assert.deepEqual(parsed.get('report-uri'), ['/api/csp-report']);
  assert.deepEqual(parsed.get('report-to'), ['csp-endpoint']);
  assert.equal(reportingEndpoints, 'csp-endpoint="/api/csp-report"');
  const [group, url] = reportingEndpoints.match(/^([a-z-]+)="([^"]+)"$/).slice(1);
  assert.equal(group, parsed.get('report-to')[0], 'report-to names the Reporting-Endpoints group');
  assert.equal(url, parsed.get('report-uri')[0], 'both mechanisms reach the same endpoint');
});

await test('script-src and connect-src allow no wildcard, scheme or host', () => {
  for (const [label, policy] of policies) {
    const parsed = directives(policy);
    for (const name of ['script-src', 'connect-src']) {
      const values = parsed.get(name);
      assert.ok(values, `${label}: ${name} is present`);
      for (const value of values) {
        assert.ok(!forbidden.includes(value), `${label}: ${name} must not contain ${value}`);
        // Every remaining source is a quoted keyword or nonce, never a host name.
        assert.match(value, /^'[^']+'$/, `${label}: ${name} source ${value} is a quoted keyword`);
      }
    }
    assert.ok(parsed.get('script-src').includes("'nonce-abc'"));
    assert.ok(parsed.get('script-src').includes("'strict-dynamic'"));
    assert.deepEqual(parsed.get('connect-src'), ["'self'"]);
  }
});

await test('first three directives match the enforced baseline in next.config.ts', async () => {
  const config = await readFile(new URL('../../next.config.ts', import.meta.url), 'utf8');
  const enforced = config.match(/key: "Content-Security-Policy", value: "([^"]+)"/)?.[1];
  assert.ok(enforced, 'enforced policy found in next.config.ts');
  for (const [label, policy] of policies) assert.equal(policy.split('; ').slice(0, 3).join('; '), enforced, label);
});

await test('nonces are base64 of at least 16 random bytes and never repeat', () => {
  const seen = new Set();
  for (let index = 0; index < 1000; index++) {
    const nonce = createNonce();
    assert.match(nonce, /^[A-Za-z0-9+/]{22,}={0,2}$/);
    assert.ok(Buffer.from(nonce, 'base64').length >= 16);
    seen.add(nonce);
  }
  assert.equal(seen.size, 1000);
});

await test('the module exports exactly the policy, the nonce and the endpoints, and has no imports', () => {
  assert.deepEqual(Object.keys(csp).sort(), ['brandingAssetPolicy', 'contentSecurityPolicy', 'createNonce', 'isBrandingAssetPath', 'reportingEndpoints']);
  assert.doesNotMatch(source, /^\s*import\b|\brequire\(/m, 'lib/server/csp.ts stays dependency-free (proxy and tests load it directly)');
});

await test('Remote Desktop cannot be unpaused while the policy blocks its WebAssembly client', async () => {
  // The IronRDP client needs 'wasm-unsafe-eval' (and connect-src data:).
  // Unpausing Remote Desktop must come with that exception in lib/server/csp.ts.
  const feature = await readFile(new URL('../../lib/rdp-feature.ts', import.meta.url), 'utf8');
  const available = feature.match(/export const REMOTE_DESKTOP_AVAILABLE\s*=\s*([^;\n]+)/)?.[1]?.trim();
  assert.ok(available, 'REMOTE_DESKTOP_AVAILABLE found in lib/rdp-feature.ts');
  for (const [label, policy] of policies) {
    assert.ok(available === 'false' || policy.includes("'wasm-unsafe-eval'"),
      `lib/rdp-feature.ts sets REMOTE_DESKTOP_AVAILABLE=${available}, but the CSP in lib/server/csp.ts (${label} origin) has no 'wasm-unsafe-eval'. Add the RDP exception ('wasm-unsafe-eval', connect-src data:) before unpausing Remote Desktop.`);
  }
});

await test('branding images keep their own sandbox policy, only on their paths', async () => {
  assert.equal(brandingAssetPolicy, "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  for (const pathname of ['/api/branding/portal/light', '/api/branding/customer/00000000-0000-4000-8000-000000000101/dark', '/api/branding/favicon']) assert.equal(isBrandingAssetPath(pathname), true, pathname);
  for (const pathname of ['/api/branding', '/api/branding/manage', '/api/branding/faviconx', '/', '/api/console', '/api/brandingx/portal/light']) assert.equal(isBrandingAssetPath(pathname), false, pathname);
  const proxySource = await readFile(new URL('../../proxy.ts', import.meta.url), 'utf8');
  assert.match(proxySource, /isBrandingAssetPath\(request\.nextUrl\.pathname\) \? brandingAssetPolicy : policy/, 'proxy.ts keeps the image policy on the image paths');
});

await test('the proxy runs on every path except build assets', async () => {
  // Compile proxy.ts's matcher with Next's own matcher code, as the build does.
  const proxySource = await readFile(new URL('../../proxy.ts', import.meta.url), 'utf8');
  const matcher = JSON.parse(proxySource.match(/matcher:\s*(\[[^\]]*\])/)[1].replaceAll("'", '"'));
  const require = createRequire(import.meta.url);
  const { getMiddlewareMatchers } = require('next/dist/build/analysis/get-page-static-info.js');
  const { getMiddlewareRouteMatcher } = require('next/dist/shared/lib/router/utils/middleware-route-matcher.js');
  const matches = getMiddlewareRouteMatcher(getMiddlewareMatchers(matcher, {}));
  for (const pathname of ['/', '/remote-desktop', '/does-not-exist', '/does-not-exist.html', '/favicon.svg', '/Agent-v3-release.json',
    '/api/console', '/api/does-not-exist', '/api/csp-report', '/downloads/missing/nested/path', '/_next/does-not-exist', '/_next/data/x.json',
    '/_next/staticx', '/_next/image', '/_next/hmr', '/_next/webpack-hmr']) {
    assert.equal(matches(pathname, { headers: {} }, {}), true, `proxy runs on ${pathname}`);
  }
  for (const pathname of ['/_next/static/chunks/app.js', '/_next/static/missing.js', '/_next/static/css/x.css']) {
    assert.equal(matches(pathname, { headers: {} }, {}), false, `${pathname} bypasses the proxy`);
  }
});

console.log(`${cases} CSP policy cases passed.`);
