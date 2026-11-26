import { spawn } from 'node:child_process';
import { readdirSync, realpathSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { futureTestNow } from '../tests/support/clock.mjs';

// Folders below tests/ whose files have no run in pnpm test: support/ holds the
// modules that tests import, fixtures/ holds data, and integration/ holds the
// files that only pnpm test:selfhost (node --test "tests/**/selfhost-*.mjs") or
// pnpm test:http (scripts/http-test.mjs) run.
export const excludedFolders = ['support', 'fixtures', 'integration'];
// These regressions exercise the portal's business rules and UI contracts: every
// .mjs file below tests/ outside the folders above, as its path relative to
// tests/ without .mjs (api/alerts, ui/devices/device-hardware), sorted, so a new
// test file runs without an edit here. Each test file says at its top what it
// covers. The folder is read relative to this script, not to the working
// directory. HTTP integration runs separately after building the actual Node
// application.
const testFolder = fileURLToPath(new URL('../tests/', import.meta.url));
export const files = readdirSync(testFolder, { recursive: true, withFileTypes: true })
  .filter(entry => entry.isFile() && entry.name.endsWith('.mjs'))
  .map(entry => path.relative(testFolder, path.join(entry.parentPath, entry.name)).split(path.sep).join('/').slice(0, -'.mjs'.length))
  .filter(name => !excludedFolders.includes(name.split('/')[0]))
  .sort();
// Date-bomb check: these files run a second time with the clock shifted to a
// future date (tests/support/fixed-clock.mjs), so a fixture that mixes the test clock
// with hard-coded dates fails in the merge check, not on the day it breaks. The
// date is today plus four years (tests/support/clock.mjs), so it never expires.
// The entries are paths in the form of files.
export const fixedClockFiles = ['ui/devices/device-hardware', 'ui/devices/device-overview', 'ui/devices/diagnostics-workspace', 'api/gpu-telemetry', 'api/hardware-inventory', 'lib/customer-admin', 'api/customer-installers', 'api/customer-technicians-revoke'];

// Importing this script (tests/repo/test-loader.mjs does) only reads the lists above.
const direct = process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (direct) await runAll();

// Each file runs in its own process with its own in-memory database, so files
// run in parallel. TEST_CONCURRENCY overrides the worker count; 1 runs them one
// after another.
function concurrency() {
  const requested = Number.parseInt(process.env.TEST_CONCURRENCY ?? '', 10);
  if (Number.isInteger(requested) && requested > 0) return requested;
  return Math.min(6, Math.max(1, Math.floor(availableParallelism() / 4)));
}

function runFile({ args, env }) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 90_000 });
    let output = '';
    const collect = chunk => { output = (output + chunk).slice(-8 * 1024 * 1024); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', error => { output += String(error); });
    child.on('close', (code, signal) => resolve({ ok: code === 0, output: signal ? `${output}\nKilled by ${signal} (timeout 90 s?)` : output }));
  });
}

// The shared test PostgreSQL (tests/support/postgres.mjs) starts once here,
// before the workers: parallel files then find it running and accepting
// connections, with the migrated template built. If it cannot start, the run
// goes on and every file that needs it reports the error itself.
async function prepareDatabase() {
  try {
    const { warmTestServer } = await import('../tests/support/postgres.mjs');
    await warmTestServer();
    console.log('Test PostgreSQL ready.');
  } catch (error) {
    console.error(`Test PostgreSQL not ready; the files that need it report the error: ${error?.message ?? error}`);
  }
}

async function runAll() {
  await prepareDatabase();
  const env = { ...process.env };
  const fixedClockNow = futureTestNow();
  const fixedClockEnv = { ...env, SERVERDESK_TEST_NOW: fixedClockNow };
  const fixedClock = pathToFileURL('tests/support/fixed-clock.mjs').href;
  const runs = [
    ...files.map(name => ({ label: name, args: [`tests/${name}.mjs`], env })),
    ...fixedClockFiles.map(name => ({ label: `${name} @${fixedClockNow.slice(0, 10)}`, args: ['--import', fixedClock, `tests/${name}.mjs`], env: fixedClockEnv })),
  ];
  let failures = 0, next = 0;
  const worker = async () => {
    while (next < runs.length) {
      const run = runs[next++];
      const result = await runFile(run);
      if (!result.ok) {
        failures++;
        const diagnostic = result.output.replaceAll(/data:application\/wasm;base64,[A-Za-z0-9+/=]+/g, '[WASM module]');
        console.error(`FAIL ${run.label}\n${diagnostic.slice(-8000)}`);
      } else console.log(`PASS ${run.label}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency(), runs.length) }, worker));
  console.log(`${runs.length - failures}/${runs.length} regression files passed.`);
  process.exitCode = failures ? 1 : 0;
}
