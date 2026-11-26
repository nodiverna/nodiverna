// pnpm test:e2e without a browser: the argument checks of
// scripts/e2e.mjs, the package entries, the browser container in
// e2e/compose.yaml, the TCP forwarder, the TOTP counter choice and the ignore
// files. The browser run itself is not part of pnpm test.
import '../support/register.mjs';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {serverDeskRoot} from '../support/paths.mjs';

const root = serverDeskRoot;
const read = file => readFileSync(path.join(root, file), 'utf8');
const pkg = JSON.parse(read('package.json'));
const version = pkg.devDependencies['@playwright/test'];

// No or a wrong BASE_URL ends with exit code 2, before any docker call.
const scratch = mkdtempSync(path.join(os.tmpdir(), 'serverdesk-e2e-harness-'));
try {
  const marker = path.join(scratch, 'docker-called');
  writeFileSync(path.join(scratch, 'docker'), `#!/bin/sh\necho called > "${marker.replaceAll('\\', '/')}"\n`);
  chmodSync(path.join(scratch, 'docker'), 0o755);
  writeFileSync(path.join(scratch, 'docker.cmd'), `@echo off\r\necho called> "${marker}"\r\n`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(path|BASE_URL|E2E_BROWSER_WS)$/i.test(key)));
  const PATH = `${scratch}${path.delimiter}${process.env.PATH ?? process.env.Path ?? ''}`;
  const run = extra => spawnSync(process.execPath, ['scripts/e2e.mjs'], {cwd: root, encoding: 'utf8', env: {...env, PATH, ...extra}, timeout: 30_000});

  let result = run({});
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stderr.trim(), 'BASE_URL is not set. Start an installation and run: BASE_URL=https://localhost:<port> pnpm test:e2e');
  assert.equal(result.stdout, '');
  result = run({BASE_URL: 'ftp://x'});
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stderr.trim(), 'BASE_URL must be an http(s) URL: ftp://x');
  result = run({BASE_URL: 'localhost:8155'});
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stderr.trim(), 'BASE_URL must be an http(s) URL: localhost:8155');
  assert.equal(existsSync(marker), false, 'no docker command was started');
} finally {
  rmSync(scratch, {recursive: true, force: true});
}

// Exact dev dependencies, the script, and nothing else runs e2e.
for (const name of ['@playwright/test', '@axe-core/playwright']) {
  assert.match(pkg.devDependencies[name] ?? '', /^\d+\.\d+\.\d+$/, `${name} has an exact version in devDependencies`);
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) assert.equal(pkg[field]?.[name], undefined, `${name} is not in ${field}`);
  assert.match(read('pnpm-lock.yaml'), new RegExp(`'${name.replace('/', '\\/')}':\\n\\s+specifier: ${pkg.devDependencies[name].replaceAll('.', '\\.')}\\n`), `pnpm-lock.yaml has ${name}`);
}
assert.equal(pkg.scripts['test:e2e'], 'node scripts/e2e.mjs');
for (const script of ['test', 'validate', 'test:selfhost']) assert.doesNotMatch(pkg.scripts[script], /e2e|playwright/, `${script} does not run e2e tests`);
assert.ok(pkg.scripts.lint.split(/\s+/).includes('e2e'), 'lint covers e2e/');
assert.doesNotMatch(read('pnpm-workspace.yaml'), /playwright/, 'no build script of a Playwright package is allowed, so no browser download at install');

// The browser container.
const compose = read('e2e/compose.yaml');
assert.equal(/image:\s*mcr\.microsoft\.com\/playwright:(v[^\s"']+)/.exec(compose)?.[1], `v${version}-noble`, 'image tag equals @playwright/test');
assert.deepEqual([...compose.matchAll(/playwright@([^\s"']+) run-server/g)].map(match => match[1]), [version], 'run-server version equals @playwright/test');
const ports = [...compose.matchAll(/^\s+-\s+"?(\S+:3555)"?$/gm)].map(match => match[1]);
assert.equal(ports.length, 1);
assert.ok(ports[0].startsWith('127.0.0.1:'), `the WebSocket port is published on 127.0.0.1 only: ${ports[0]}`);
assert.match(ports[0], /^127\.0\.0\.1:\$\{E2E_BROWSER_PORT:-3555\}:3555$/);
assert.match(compose, /^\s+init: true$/m);
assert.match(compose, /^\s+shm_size: (?:[1-9]\d*gb|\d{4,}mb)$/m);
assert.match(compose, /^\s+- host\.docker\.internal:host-gateway$/m);
const volumes = /volumes:\n((?:\s+- .+\n)+)/.exec(compose)?.[1].trim().split('\n').map(line => line.trim());
assert.deepEqual(volumes, ['- ./browser:/e2e:ro'], 'only e2e/browser/ is mounted, read-only');

// The forwarder passes bytes through unchanged and closes completely.
const {startForward, upstreamFrom} = await import('../../e2e/browser/forward.mjs');
const echo = net.createServer(socket => socket.pipe(socket));
echo.listen(0, '127.0.0.1');
await once(echo, 'listening');
const forward = startForward({listenHost: '127.0.0.1', listenPort: 0, upstreamHost: '127.0.0.1', upstreamPort: echo.address().port});
if (!forward.listening) await once(forward, 'listening');
const forwardPort = forward.address().port;
const payload = randomBytes(256 * 1024);
const client = net.connect({host: '127.0.0.1', port: forwardPort});
await once(client, 'connect');
const received = [];
let length = 0;
const complete = new Promise(resolve => client.on('data', chunk => {
  received.push(chunk);
  length += chunk.length;
  if (length >= payload.length) resolve();
}));
client.write(payload);
await complete;
assert.ok(Buffer.concat(received).equals(payload), 'the echoed bytes are unchanged');
await new Promise(resolve => forward.close(resolve));
await once(client, 'close');
const refused = await new Promise(resolve => {
  const probe = net.connect({host: '127.0.0.1', port: forwardPort});
  probe.on('connect', () => {
    probe.destroy();
    resolve(false);
  });
  probe.on('error', () => resolve(true));
});
assert.equal(refused, true, 'after close() the port accepts no connection');
echo.close();
assert.deepEqual(upstreamFrom({E2E_APP_PORT: '8155'}), {listenPort: 8155, upstreamHost: 'host.docker.internal', upstreamPort: 8155});
assert.deepEqual(upstreamFrom({E2E_APP_PORT: '8155', E2E_APP_UPSTREAM: '172.17.0.1:9443'}), {listenPort: 8155, upstreamHost: '172.17.0.1', upstreamPort: 9443});
assert.throws(() => upstreamFrom({}), /E2E_APP_PORT/);
assert.throws(() => upstreamFrom({E2E_APP_PORT: '8155', E2E_APP_UPSTREAM: 'nohost'}), /E2E_APP_UPSTREAM/);

// RFC 6238 vector and the choice of the next free counter.
const {chooseCounter, nextTotp, totp, TOTP_MARGIN_MS, TOTP_STEP_MS} = await import('../../e2e/support/totp.ts');
assert.equal(totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', Math.floor(59_000 / TOTP_STEP_MS)), '287082');
const current = 58_000_000;
const now = current * TOTP_STEP_MS + 12_345;
assert.deepEqual(chooseCounter(current - 5, now), {counter: current - 1, waitMs: 0});
assert.deepEqual(chooseCounter(null, now), {counter: current - 1, waitMs: 0});
assert.deepEqual(chooseCounter(current - 1, now), {counter: current, waitMs: 0});
assert.deepEqual(chooseCounter(current, now), {counter: current + 1, waitMs: 0});
assert.deepEqual(chooseCounter(current + 1, now), {counter: null, waitMs: TOTP_STEP_MS - 12_345});
assert.deepEqual(chooseCounter(current + 1, (current + 1) * TOTP_STEP_MS), {counter: current + 2, waitMs: 0});
// In the last seconds of a window current-1 would expire on the way to the server: the next free counter wins.
const late = (current + 1) * TOTP_STEP_MS - TOTP_MARGIN_MS + 1;
assert.deepEqual(chooseCounter(null, late), {counter: current, waitMs: 0});
assert.deepEqual(chooseCounter(current - 5, late), {counter: current, waitMs: 0});
assert.deepEqual(chooseCounter(current, late), {counter: current + 1, waitMs: 0});
assert.deepEqual(chooseCounter(null, late - 1), {counter: current - 1, waitMs: 0}, 'exactly the margin left still takes current-1');
assert.deepEqual(await nextTotp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 0, () => 59_000), {code: totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 1), counter: 1});

// Ignore files and the runtime stage of the image.
for (const file of ['.gitignore', '.dockerignore']) {
  const lines = read(file).split(/\r?\n/).map(line => line.trim().replace(/^\//, ''));
  for (const entry of ['e2e/.auth/', 'e2e/artifacts/']) assert.ok(lines.includes(entry), `${file} excludes ${entry}`);
}
const dockerfile = read('Dockerfile');
const runtimeStart = dockerfile.search(/^FROM\s+\S+\s+AS\s+runtime\b/im);
assert.ok(runtimeStart > 0, 'the Dockerfile has a runtime stage');
const runtime = dockerfile.slice(runtimeStart);
assert.doesNotMatch(runtime, /e2e|playwright/i, 'the runtime stage mentions neither e2e nor playwright');

console.log('e2e harness checks passed.');
