import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase, sql } from '../../runtime/database.mjs';

// Test databases on PostgreSQL. With TEST_DATABASE_URL (an admin URL, the
// password may be inside) the tests use that server. Without it, one shared
// container serverdesk-test-postgres runs on this machine: data on tmpfs, no
// fsync, the port only on 127.0.0.1 and a random password that is read back
// through docker inspect. A process that finds the container missing,
// created, stopped or without its published port waits for it (up to three
// minutes, which covers the image pull of a first start). Each migration state
// gets one template database sd_tpl_<hash>; each test process copies it into
// its own database and drops that database again when it closes or exits, also
// after a failure. The data lives in the memory of the container, so a
// database that a crashed or killed process leaves behind takes memory from all
// other test runs: a leftover without connections is dropped after 2 hours,
// any leftover after 6 hours.

const root = fileURLToPath(new URL('../../', import.meta.url));
export const containerName = 'serverdesk-test-postgres';
export const image = 'postgres:17-alpine';
const unavailable = 'No PostgreSQL for the tests. Set TEST_DATABASE_URL to an admin URL of a PostgreSQL 17 server, or start Docker so the tests can run the container serverdesk-test-postgres.';
const maxAgeMs = 6 * 60 * 60_000;
const idleMaxAgeMs = 2 * 60 * 60_000;
// The real time, also under the shifted clock of tests/support/fixed-clock.mjs: a run
// with a future date must not take every current database for a leftover.
const realNow = () => performance.timeOrigin + performance.now();
const runId = process.env.SERVERDESK_TEST_RUN ?? `${Math.floor(realNow() / 1000).toString(36)}_${randomBytes(3).toString('hex')}`;
let counter = 0;
let serverPromise;

// How long a process waits for the shared container: the first start on a
// fresh machine pulls the image, and parallel test processes find the
// container created but not running, or running before its port is published.
const startDeadlineMs = 180_000;
const startPollMs = 500;

/** One docker call: resolves to {status, stdout, stderr}; never rejects. */
export function runDocker(args) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn('docker', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ status: null, stdout: '', stderr: String(error?.message ?? error) });
      return;
    }
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', error => { stderr += String(error?.message ?? error); });
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
}

const firstLine = text => String(text ?? '').trim().split('\n')[0].trim();

/**
 * The state of the shared container: {missing: true} when docker inspect finds
 * none, else {status, running, password, port}. The port is null until Docker
 * has published it.
 */
async function containerState(docker) {
  const inspect = await docker(['inspect', '--format', '{{.State.Status}}|{{.State.Running}}|{{range .Config.Env}}{{println .}}{{end}}', containerName]);
  if (inspect.status !== 0) return { missing: true };
  const [status, running, environment = ''] = inspect.stdout.split('|');
  const password = environment.split('\n').find(line => line.startsWith('POSTGRES_PASSWORD='))?.slice('POSTGRES_PASSWORD='.length).trim() || null;
  let port = null;
  if (running.trim() === 'true') {
    const published = await docker(['port', containerName, '5432/tcp']);
    port = published.status === 0 ? published.stdout.split('\n').map(line => /127\.0\.0\.1:(\d+)/.exec(line)?.[1]).find(Boolean) ?? null : null;
  }
  return { missing: false, status: status.trim(), running: running.trim() === 'true', password, port };
}

/**
 * Finds or starts the shared container and returns its admin address
 * {url, password}. Several processes may call this at the same time on a
 * machine without the container or the image: one docker run wins, the others
 * get "already in use" or find the container created, not yet running or
 * without its port, and wait for it until the deadline. The options are the
 * seam of tests/repo/test-postgres-start.mjs: a fake docker (same result shape
 * as runDocker), a short deadline, the poll interval and the clock.
 */
export async function startContainer({ docker = runDocker, deadlineMs = startDeadlineMs, pollMs = startPollMs, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const version = await docker(['version', '--format', '{{.Server.Version}}']);
  if (version.status !== 0) throw new Error(`${unavailable} (docker: ${firstLine(version.stderr) || 'not found'})`);
  const deadline = now() + deadlineMs;
  let last = 'no answer from docker yet';
  for (;;) {
    const state = await containerState(docker);
    if (state.missing) {
      const password = randomBytes(24).toString('hex');
      const created = await docker(['run', '-d', '--name', containerName, '--memory', '2g', '--cpus', '2',
        '--tmpfs', '/var/lib/postgresql/data:rw', '-e', `POSTGRES_PASSWORD=${password}`, '-p', '127.0.0.1::5432',
        image, '-c', 'fsync=off', '-c', 'synchronous_commit=off', '-c', 'full_page_writes=off', '-c', 'max_connections=300']);
      // "already in use": a parallel process created it first; the next round
      // finds it. Any other failure (a broken pull, for example) is tried again
      // until the deadline.
      last = created.status === 0 ? 'docker run started the container' : `docker run: ${firstLine(created.stderr) || `exit ${created.status}`}`;
    } else if (state.running && state.password && state.port) {
      return { url: `postgres://postgres@127.0.0.1:${state.port}/postgres`, password: state.password };
    } else if (!state.running) {
      // Created by a parallel docker run that has not started it yet, or
      // stopped (for example after a restart of Docker): start it. A start
      // that races with the docker run of another process is harmless.
      const started = await docker(['start', containerName]);
      last = `container ${state.status || 'not running'}${started.status === 0 ? '' : `, docker start: ${firstLine(started.stderr) || `exit ${started.status}`}`}`;
    } else last = state.password ? 'container running, port 5432 not published yet' : 'container running without POSTGRES_PASSWORD';
    if (now() >= deadline) throw new Error(`${unavailable} (the container ${containerName} did not start within ${Math.round(deadlineMs / 1000)} s; last Docker state: ${last})`);
    await sleep(pollMs);
  }
}

/**
 * The admin connection of the test server: {url, password} without
 * credentials in the URL. TEST_DATABASE_URL bypasses Docker completely.
 */
export async function adminAddress({ env = process.env, ...start } = {}) {
  const configured = env.TEST_DATABASE_URL;
  if (!configured) return startContainer(start);
  const parsed = new URL(configured);
  const password = decodeURIComponent(parsed.password);
  parsed.password = '';
  return { url: parsed.toString(), password };
}

async function connectAdmin(address, deadline) {
  for (;;) {
    const admin = createDatabase({ ...address, max: 1, connectTimeoutMs: 2000, idleTimeoutSeconds: 1 });
    try {
      await admin.one(sql`SELECT 1 AS ready`);
      return admin;
    } catch (error) {
      await admin.close().catch(() => {});
      if (Date.now() > deadline) throw new Error(`${unavailable} (${error?.message ?? error})`);
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }
}

function migrationHash() {
  const directory = path.join(root, 'drizzle');
  const hash = createHash('sha256');
  for (const name of readdirSync(directory).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort()) {
    hash.update(name).update('\0').update(readFileSync(path.join(directory, name), 'latin1').replaceAll('\r\n', '\n')).update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

const databaseUrl = (address, name) => {
  const parsed = new URL(address.url);
  parsed.pathname = '/' + name;
  return parsed.toString();
};

async function prepareServer() {
  const address = await adminAddress();
  const admin = await connectAdmin(address, Date.now() + 60_000);
  try {
    // Leftovers of crashed or killed runs: test databases older than six
    // hours, or older than two hours without a connection. A test file runs
    // for 90 seconds at most in scripts/test.mjs; the builds of
    // scripts/http-test.mjs and tests/integration/http-selfhost.mjs hold their
    // database for minutes, often without a connection.
    const cutoff = Math.floor((realNow() - maxAgeMs) / 1000), idleCutoff = Math.floor((realNow() - idleMaxAgeMs) / 1000);
    // A name from a later day cannot belong to a running test.
    const future = Math.floor(realNow() / 1000) + 86_400;
    for (const { datname, connected } of await admin.query(sql`SELECT datname, EXISTS (SELECT 1 FROM pg_stat_activity a WHERE a.datname=d.datname) AS connected FROM pg_database d WHERE datname LIKE 'sd\_t\_%'`)) {
      const created = Number.parseInt(datname.split('_')[2], 36);
      if (Number.isSafeInteger(created) && (created < cutoff || created > future || (created < idleCutoff && !connected))) await admin.exec(sql`DROP DATABASE IF EXISTS ${sql.ident(datname)} WITH (FORCE)`).catch(() => {});
    }
    const template = `sd_tpl_${migrationHash()}`;
    // The build lock lives on a connection of its own. The admin pool closes a
    // connection after one idle second, and with it a session lock: while the
    // migrations ran, a parallel process could take the lock, drop the
    // half-built template and leave the first process with "database
    // sd_tpl_<hash>_build does not exist".
    const lock = createDatabase({ ...address, max: 1, connectTimeoutMs: 2000, idleTimeoutSeconds: 600 });
    try {
      await lock.one(sql`SELECT pg_advisory_lock(hashtext(${'serverdesk-test-template:' + template})) AS locked`);
      if (!await admin.one(sql`SELECT 1 AS present FROM pg_database WHERE datname=${template}`)) {
        const building = `${template}_build`;
        await admin.exec(sql`DROP DATABASE IF EXISTS ${sql.ident(building)} WITH (FORCE)`);
        await admin.exec(sql`CREATE DATABASE ${sql.ident(building)}`);
        const target = createDatabase({ url: databaseUrl(address, building), password: address.password, max: 2, idleTimeoutSeconds: 1 });
        try {
          const { migrateDatabase } = await import('../../scripts/selfhost.mjs');
          await migrateDatabase(target);
        } finally {
          await target.close();
        }
        await admin.exec(sql`ALTER DATABASE ${sql.ident(building)} RENAME TO ${sql.ident(template)}`);
      }
    } finally {
      // Closing the connection also ends the session lock.
      await lock.close().catch(() => {});
    }
    return { address, admin, template };
  } catch (error) {
    await admin.close().catch(() => {});
    throw error;
  }
}

/**
 * Starts or finds the test server, waits until it accepts connections and
 * builds the migrated template once, then closes the connection.
 * scripts/test.mjs calls it before its parallel workers start.
 */
export async function warmTestServer() {
  const { admin } = await prepareServer();
  await admin.close();
}

const open = new Set();
let exitHook = false;

async function dropAll() {
  const pending = [...open];
  open.clear();
  if (!pending.length || !serverPromise) return;
  const { admin } = await serverPromise;
  for (const name of pending) await admin.exec(sql`DROP DATABASE IF EXISTS ${sql.ident(name)} WITH (FORCE)`).catch(() => {});
  await admin.close().catch(() => {});
  serverPromise = undefined;
}

function dropSync(address) {
  if (!open.size) return;
  const names = [...open];
  open.clear();
  spawnSync(process.execPath, [fileURLToPath(new URL('./drop-databases.mjs', import.meta.url))], {
    env: { ...process.env, SD_DROP_URL: address.url, SD_DROP_PASSWORD: address.password, SD_DROP_NAMES: JSON.stringify(names) },
    stdio: 'ignore', timeout: 15_000, windowsHide: true,
  });
}

/**
 * A new, empty database of this test process. With `template` false it has no
 * schema; otherwise it is a copy of the migrated template. Returns the address
 * {url, password, name} and a drop() function.
 */
export async function createTestDatabase({ template = true } = {}) {
  serverPromise ??= prepareServer();
  let server;
  try {
    server = await serverPromise;
  } catch (error) {
    serverPromise = undefined;
    throw error;
  }
  if (!exitHook) {
    exitHook = true;
    process.once('beforeExit', () => { dropAll().catch(() => {}); });
    // A failed assertion or process.exit() skips beforeExit, and an exit
    // handler cannot wait for a promise: a short child process drops the rest.
    process.once('exit', () => { dropSync(server.address); });
  }
  const name = `sd_t_${runId}_${process.pid}_${++counter}`;
  await server.admin.exec(template ? sql`CREATE DATABASE ${sql.ident(name)} TEMPLATE ${sql.ident(server.template)}` : sql`CREATE DATABASE ${sql.ident(name)}`);
  open.add(name);
  return {
    name,
    url: databaseUrl(server.address, name),
    password: server.address.password,
    async drop() {
      if (!open.delete(name)) return;
      await server.admin.exec(sql`DROP DATABASE IF EXISTS ${sql.ident(name)} WITH (FORCE)`).catch(() => {});
      if (!open.size && serverPromise) {
        serverPromise = undefined;
        await server.admin.close().catch(() => {});
      }
    },
  };
}

/**
 * A data-layer pool on a fresh test database. close() ends the pool and drops
 * the database. At most four connections per test pool.
 */
export async function testDatabase({ template = true, max = 4 } = {}) {
  const target = await createTestDatabase({ template });
  const database = createDatabase({ url: target.url, password: target.password, max: Math.min(4, max), idleTimeoutSeconds: 1 });
  const close = database.close;
  return Object.assign(database, {
    url: target.url,
    password: target.password,
    name: target.name,
    async close() {
      await close();
      await target.drop();
    },
  });
}

/** True when docker is on PATH; used by scripts that print a hint. */
export function dockerAvailable() {
  try {
    execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}
