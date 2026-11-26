// Covers the response headers next.config.ts adds per path, run through Next's own route
// loading (loadCustomRoutes) and matcher (buildCustomRoute, as the router server uses it).
// A config header replaces the one a route handler sends, so the branding image routes and the
// brand scheme stylesheet (/api/branding/scheme) must get no Cache-Control from here (their own immutable / no-cache value has to reach the
// browser), while every other /api path, /api/branding and /api/branding/manage included,
// keeps no-store. Handler tests call the route directly and cannot see this override.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import { serverDeskRoot } from '../support/paths.mjs';

const require = createRequire(import.meta.url);
const { PHASE_PRODUCTION_SERVER } = require('next/constants');

// Load next.config.ts the way Next does: compiled to CommonJS, so its bare 'next/constants'
// import resolves like in the build.
const configFile = path.join(serverDeskRoot, 'next.config.ts');
const configModule = new Module(configFile);
configModule.filename = configFile;
configModule.paths = Module._nodeModulePaths(serverDeskRoot);
configModule._compile(ts.transpileModule(await readFile(configFile, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, configFile);
const nextConfig = configModule.exports.default;
const loadCustomRoutes = require('next/dist/lib/load-custom-routes.js').default;
const { buildCustomRoute } = require('next/dist/server/lib/router-utils/filesystem.js');

let cases = 0;
async function test(name, run) { await run(); cases++; console.log('PASS ' + name); }

const config = nextConfig(PHASE_PRODUCTION_SERVER);
const { headers: loaded } = await loadCustomRoutes(config);
const routes = loaded.map(item => buildCustomRoute('header', item, config.basePath, false));

// Mirrors resolve-routes: every matching header route in order, a later value wins per key.
function configHeaders(pathname) {
  const out = new Map();
  for (const route of routes) {
    if (!route.match(pathname)) continue;
    for (const { key, value } of route.headers) out.set(key.toLowerCase(), value);
  }
  return out;
}

const imagePaths = [
  '/api/branding/portal/light',
  '/api/branding/portal/dark',
  '/api/branding/portal/icon',
  '/api/branding/customer/3f0c2a52-9a1e-4c6e-9d3b-1b2a3c4d5e6f/light',
  '/api/branding/customer/3f0c2a52-9a1e-4c6e-9d3b-1b2a3c4d5e6f/dark',
  '/api/branding/favicon',
  '/api/branding/portal/signin',
  '/api/branding/portal/console',
  // The brand scheme stylesheet revalidates with its own no-cache and ETag.
  '/api/branding/scheme',
];
const noStorePaths = [
  '/api/branding',
  '/api/branding/manage',
  '/api/branding/favicon/extra',
  '/api/branding/portals',
  '/api/branding/schemes',
  '/api/branding/scheme/x',
  '/api/brandingx/portal/light',
  '/api/health/ready',
  '/api/session',
  '/api/devices/abc',
  '/api/x/branding/portal/light',
];

await test('next.config.ts headers pass Next validation and compile', () => {
  assert.ok(routes.length >= 3, 'header routes loaded');
  for (const route of routes) assert.equal(typeof route.match, 'function', route.source);
});

await test('branding image routes and the scheme stylesheet get no Cache-Control from the config, so the route value stands', () => {
  for (const pathname of imagePaths) {
    const headers = configHeaders(pathname);
    assert.equal(headers.has('cache-control'), false, `${pathname}: ${headers.get('cache-control')}`);
    assert.equal(headers.get('referrer-policy'), 'no-referrer', `${pathname} keeps the API referrer policy`);
    assert.equal(headers.get('x-content-type-options'), 'nosniff', `${pathname} keeps nosniff`);
  }
});

await test('every other /api path keeps no-store and no-referrer', () => {
  for (const pathname of noStorePaths) {
    const headers = configHeaders(pathname);
    assert.equal(headers.get('cache-control'), 'no-store', pathname);
    assert.equal(headers.get('referrer-policy'), 'no-referrer', pathname);
  }
});

await test('downloads keep no-store and pages get no Cache-Control from the config', () => {
  assert.equal(configHeaders('/downloads/agent.msi').get('cache-control'), 'no-store');
  assert.equal(configHeaders('/').has('cache-control'), false);
  assert.equal(configHeaders('/').get('referrer-policy'), 'strict-origin-when-cross-origin');
});

console.log(`${cases} next.config.ts header checks passed`);
