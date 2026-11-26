#!/usr/bin/env node
// pnpm test:e2e: browser smoke test against a running installation at BASE_URL.
// Chromium runs in the container from e2e/compose.yaml unless
// E2E_BROWSER_WS points to a running `playwright run-server`. Further arguments
// go to `playwright test` (for example --project desktop). The exit code is
// Playwright's; 2 means BASE_URL is missing or invalid, 3 that the browser
// container could not be started.
import {spawn, spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import net from 'node:net';
import path from 'node:path';
import {rmSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const project = 'serverdesk-e2e';
const composeFile = 'e2e/compose.yaml';
const fail = (code, text) => {
  console.error(text);
  process.exit(code);
};

const raw = process.env.BASE_URL?.trim();
if (!raw) fail(2, 'BASE_URL is not set. Start an installation and run: BASE_URL=https://localhost:<port> pnpm test:e2e');
let base = null;
try {
  base = new URL(raw);
} catch {
  // Reported below like any other non-http(s) value.
}
if (!base || !['http:', 'https:'].includes(base.protocol) || !base.hostname) fail(2, `BASE_URL must be an http(s) URL: ${raw}`);

const appPort = base.port || (base.protocol === 'https:' ? '443' : '80');
const browserPort = process.env.E2E_BROWSER_PORT?.trim() || '3555';
const composeEnv = {...process.env, E2E_APP_PORT: appPort, E2E_BROWSER_PORT: browserPort};
const compose = (...args) => spawnSync('docker', ['compose', '-p', project, '-f', composeFile, ...args], {cwd: root, env: composeEnv, encoding: 'utf8', stdio: ['ignore', 'inherit', 'inherit'], timeout: 600_000});

/** One HTTP request to the run-server port; any HTTP answer means it listens (Docker's port proxy alone does not answer). */
function answers(port) {
  return new Promise(resolve => {
    const socket = net.connect({host: '127.0.0.1', port});
    let data = '';
    const done = result => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(3000, () => done(false));
    socket.on('error', () => done(false));
    socket.on('close', () => done(data.startsWith('HTTP/')));
    socket.on('connect', () => socket.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`));
    socket.on('data', chunk => {
      data += chunk.toString('latin1');
      if (data.startsWith('HTTP/')) done(true);
    });
  });
}

async function waitForBrowser(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await answers(port)) return true;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return false;
}

let wsEndpoint = process.env.E2E_BROWSER_WS?.trim();
const ownContainer = !wsEndpoint;
const keep = process.env.E2E_KEEP_BROWSER === '1';
const down = () => {
  if (ownContainer && !keep) compose('down', '--remove-orphans');
};

if (ownContainer) {
  const info = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {encoding: 'utf8', timeout: 30_000});
  if (info.status !== 0 || !info.stdout?.trim()) fail(3, 'Docker is not reachable. Start Docker or set E2E_BROWSER_WS to a running playwright run-server.');
  const up = compose('up', '-d');
  if (up.status !== 0) {
    down();
    fail(3, `docker compose up failed for ${composeFile} (exit ${up.status ?? up.error?.code}).`);
  }
  if (!await waitForBrowser(Number(browserPort), 120_000)) {
    compose('logs', '--tail', '50');
    down();
    fail(3, `The browser container did not accept connections on 127.0.0.1:${browserPort} within 120 s.`);
  }
  wsEndpoint = `ws://127.0.0.1:${browserPort}/`;
}

// A new run starts with empty artifacts (screenshots, axe reports, HTML report).
rmSync(path.join(root, 'e2e', 'artifacts'), {recursive: true, force: true});

const cli = createRequire(import.meta.url).resolve('@playwright/test/cli');
const child = spawn(process.execPath, [cli, 'test', '-c', 'e2e/playwright.config.ts', ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
  env: {...process.env, BASE_URL: raw, E2E_BROWSER_WS: wsEndpoint},
});
// Ctrl+C reaches Playwright directly; this process waits for it and cleans up.
const ignore = () => {};
process.on('SIGINT', ignore);
process.on('SIGTERM', ignore);
const code = await new Promise(resolve => {
  child.on('error', error => {
    console.error(`playwright test could not start: ${error.message}`);
    resolve(1);
  });
  child.on('exit', (status, signal) => resolve(status ?? (signal ? 1 : 0)));
});
down();
process.exit(code);
