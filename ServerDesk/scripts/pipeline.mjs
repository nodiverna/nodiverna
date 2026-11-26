import { spawn } from 'node:child_process';
import { rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const [operation = 'verify', ...arguments_] = process.argv.slice(2);
const argumentsCopy = [...arguments_];
function option(name, fallback) {
  const at = argumentsCopy.indexOf(name);
  if (at < 0) return fallback;
  const value = argumentsCopy[at + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}.`);
  argumentsCopy.splice(at, 2);
  return value;
}
function flag(name) {
  const at = argumentsCopy.indexOf(name);
  if (at < 0) return false;
  argumentsCopy.splice(at, 1);
  return true;
}
const selectedImage = option('--image');
const image = selectedImage || process.env.SERVERDESK_IMAGE || 'serverdesk:local';
if (!/^[A-Za-z0-9][A-Za-z0-9./:_-]*$/.test(image)) throw new Error('Invalid image reference.');
const dev = flag('--dev');
// --production selects compose.yaml, which is also the default. Kept for existing scripts.
const production = flag('--production');
if (dev && production) throw new Error('--dev and --production cannot be combined.');
const migrate = flag('--migrate');
const statePath = path.join(project, '.env.deployment');
// compose.yaml pulls the published image and never builds. For a local image
// run `image --image <tag>` first and pass the same tag to `up --image`.
const composeFiles = [dev ? 'compose.dev.yaml' : 'compose.yaml'];
function composeArguments() {
  return ['compose', '--env-file', '.env.runtime',
    ...(existsSync(statePath) ? ['--env-file', '.env.deployment'] : []), ...composeFiles.flatMap(file => ['-f', file])];
}
const environment = { ...process.env, ...(selectedImage ? { SERVERDESK_IMAGE: image } : {}) };

function run(command, args, { capture = false, allowFailure = false, env = environment } = {}) {
  return new Promise((resolve, reject) => {
    // pnpm's Windows shim is a batch file. Only the fixed validation/install arguments
    // below reach this shell; Docker and all user input use direct argv.
    const shim = process.platform === 'win32' && command === 'pnpm';
    const child = spawn(shim ? 'pnpm.cmd' : command, args, {
      cwd: project, env, shell: shim, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    });
    let output = '';
    if (capture) child.stdout.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0 || allowFailure) resolve(output.trim());
      else reject(new Error(`${command} ${args[0] ?? ''} failed (exit ${code}).`));
    });
  });
}
function noRemaining() {
  if (argumentsCopy.length) throw new Error(`Unexpected arguments: ${argumentsCopy.join(' ')}`);
}
const smokeSecrets = {
  SESSION_SECRET: 'serverdesk-smoke-session-000000000000000000000000000000000000000000',
  PASSWORD_PEPPER: 'serverdesk-smoke-pepper-0000000000000000000000000000000000000000000',
};
async function smoke() {
  const id = `serverdesk-smoke-${Date.now()}-${process.pid}`;
  const network = `${id}-net`, database = `${id}-db`, restoreDatabase = `${id}-restore`;
  const volume = `${id}-data`, dbVolume = `${id}-db-data`, restoreVolume = `${id}-restore-data`;
  const modulesVolume = `${id}-node-modules`;
  const nextVolume = `${id}-next`;
  const volumes = [volume, dbVolume, restoreVolume, ...(dev ? [modulesVolume, nextVolume] : [])];
  const mounts = ['-v', `${volume}:/data`, ...(dev ? ['-v', `${project}:/app`, '-v', `${modulesVolume}:/app/node_modules`, '-v', `${nextVolume}:/app/.next`] : [])];
  // The generated password reaches the containers through the environment of
  // the docker command (-e NAME without a value), never as an argument.
  const password = Array.from(crypto.getRandomValues(new Uint8Array(24)), byte => byte.toString(16).padStart(2, '0')).join('');
  const secretEnv = { ...environment, POSTGRES_PASSWORD: password, DATABASE_PASSWORD: password };
  // The smoke database answers as `db` (a local host: no TLS, as in compose.yaml),
  // so the app's startup check accepts the plain connection. The restore target
  // is reached only by the CLI, which takes an explicit sslmode=disable.
  const appEnv = (url) => ['--network', network, '-e', `SESSION_SECRET=${smokeSecrets.SESSION_SECRET}`, '-e', `PASSWORD_PEPPER=${smokeSecrets.PASSWORD_PEPPER}`,
    '-e', 'SITE_ORIGIN=https://localhost', '-e', `NODE_ENV=${dev ? 'development' : 'production'}`,
    '-e', `DATABASE_URL=${url}`, '-e', 'DATABASE_PASSWORD',
    '-e', 'OBJECT_STORAGE_DRIVER=filesystem', '-e', 'OBJECT_STORAGE_PATH=/data/objects', '-e', 'BACKUP_DIRECTORY=/data/backups'];
  const testEnv = appEnv('postgres://serverdesk@db:5432/serverdesk');
  const developmentCommand = ['node', '--import', './runtime/startup.mjs', 'node_modules/next/dist/bin/next', 'dev', '--webpack', '--hostname', '0.0.0.0', '--port', '3000'];
  const health = dev ? ['--health-cmd', "node -e \"fetch('http://127.0.0.1:3000/api/health/ready',{signal:AbortSignal.timeout(8000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"",
    '--health-interval', '10s', '--health-timeout', '10s', '--health-start-period', '90s', '--health-retries', '12'] : [];
  const startDatabase = async (name, dataVolume, alias) => {
    await run('docker', ['run', '-d', '--name', name, '--network', network, ...(alias ? ['--network-alias', alias] : []), '-e', 'POSTGRES_USER=serverdesk', '-e', 'POSTGRES_DB=serverdesk', '-e', 'POSTGRES_PASSWORD',
      '-v', `${dataVolume}:/var/lib/postgresql/data`, 'postgres:17-alpine'], { env: secretEnv });
    for (let attempt = 0; attempt < 60; attempt++) {
      const ready = await run('docker', ['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'serverdesk', '-d', 'serverdesk'], { capture: true, allowFailure: true });
      if (/accepting connections/.test(ready)) return;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error(`PostgreSQL ${name} did not become ready.`);
  };
  const selfhost = (args, env = testEnv) => run('docker', ['run', '--rm', ...mounts, ...env, image, 'node', 'scripts/selfhost.mjs', ...args], { env: secretEnv, capture: true });
  try {
    await run('docker', ['network', 'create', network]);
    for (const name of volumes) await run('docker', ['volume', 'create', name]);
    await startDatabase(database, dbVolume, 'db');
    await selfhost(['migrate']);
    // Back up and restore that dump into a second, empty database.
    const backup = JSON.parse(await selfhost(['backup', '--output', '/data/backups/smoke.dump']));
    if (backup.file !== '/data/backups/smoke.dump' || !/^[0-9a-f]{64}$/.test(backup.sha256)) throw new Error('The smoke backup did not report its file and checksum.');
    await startDatabase(restoreDatabase, restoreVolume);
    const restored = await selfhost(['restore', '--input', '/data/backups/smoke.dump'], appEnv(`postgres://serverdesk@${restoreDatabase}:5432/serverdesk?sslmode=disable`));
    if (!/0000_baseline\.sql/.test(restored)) throw new Error('The restored database does not list the baseline migration.');
    console.log('Backup and restore into an empty database: OK');
    await run('docker', ['run', '-d', '--name', id, ...mounts, ...testEnv, ...health, image, ...(dev ? developmentCommand : [])], { env: secretEnv });
    let ready = false;
    for (let attempt = 0; attempt < (dev ? 120 : 60); attempt++) {
      const status = await run('docker', ['inspect', '--format', '{{.State.Health.Status}}', id], { capture: true });
      if (status === 'healthy') { ready = true; break; }
      if (status === 'unhealthy') break;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    if (!ready) throw new Error('Container readiness did not become healthy.');
    const probe = "const live=await fetch('http://127.0.0.1:3000/api/health/live'); const ready=await fetch('http://127.0.0.1:3000/api/health/ready'); if(!live.ok||!ready.ok)process.exit(1); if(process.getuid()!==1000)process.exit(2); console.log('Live + ready + non-root: OK');";
    await run('docker', ['exec', id, 'node', '--input-type=module', '-e', probe]);
    // The scheduler in the app container runs maintenance by itself (first tick
    // 30 s after the start): wait up to 120 s for exactly one succeeded 'schedule' row.
    const maintenanceProbe = "const {createDatabase,sql}=await import('./runtime/database.mjs'); const d=createDatabase(); let rows=[]; for(let second=0;second<120;second++){rows=await d.query(sql`SELECT status,trigger FROM maintenance_runs`); if(rows.length&&rows.every(row=>row.status!=='running'))break; await new Promise(resolve=>setTimeout(resolve,1000));} await d.close(); if(rows.length!==1||rows[0].status!=='succeeded'||rows[0].trigger!=='schedule')process.exit(3); console.log('Scheduled maintenance run recorded: OK');";
    await run('docker', ['exec', id, 'node', '--input-type=module', '-e', maintenanceProbe]);
    await run('docker', ['restart', id]);
    // Nothing is pending now: migrate writes no backup.
    const again = JSON.parse(await run('docker', ['exec', id, 'node', 'scripts/selfhost.mjs', 'migrate'], { capture: true }));
    if (again.backup || (Array.isArray(again.applied) ? again.applied.length : again.applied)) throw new Error('A second migrate wrote a backup or applied a migration.');
    console.log('Container smoke passed; migrated data survived restart, no backup without pending migrations.');
  } catch (error) {
    await run('docker', ['logs', '--tail', '100', id], { allowFailure: true });
    throw error;
  } finally {
    for (const name of [id, database, restoreDatabase]) await run('docker', ['rm', '-f', name], { allowFailure: true });
    for (const name of volumes) await run('docker', ['volume', 'rm', name], { allowFailure: true });
    await run('docker', ['network', 'rm', network], { allowFailure: true });
  }
}
try {
  switch (operation) {
    case 'verify':
      noRemaining();
      // test:http builds its own copy of the tree with a throwaway test publisher.
      for (const task of ['validate', 'test:http']) await run('pnpm', ['run', task]);
      break;
    case 'install':
      noRemaining();
      await run('pnpm', ['install', '--frozen-lockfile']);
      break;
    case 'agent':
      noRemaining();
      await run(process.execPath, ['scripts/package-agent-v3.mjs']);
      await run(process.execPath, ['--env-file-if-exists=.env.local', 'scripts/build-agent-v3.mjs']);
      await run(process.execPath, ['--env-file-if-exists=.env.local', 'scripts/sign-agent-release.mjs']);
      break;
    case 'image':
      noRemaining();
      await run('docker', ['build', '--target', dev ? 'development' : 'runtime', '--tag', image, '.']);
      break;
    case 'smoke': noRemaining(); await smoke(); break;
    case 'up':
      noRemaining();
      if (migrate) {
        await run('docker', [...composeArguments(), 'stop', 'app']);
        await run('docker', [...composeArguments(), 'run', '--rm', 'app', 'node', 'scripts/selfhost.mjs', 'migrate']);
      }
      await run('docker', [...composeArguments(), 'up', '-d', '--wait', '--wait-timeout', '120']);
      if (!dev && (selectedImage || process.env.SERVERDESK_IMAGE)) {
        const temporary = `${statePath}.${process.pid}.tmp`;
        await writeFile(temporary, `SERVERDESK_IMAGE=${image}\nSERVERDESK_DEPLOYMENT_MODE=production\nCOMPOSE_FILE=compose.yaml\n`, { mode: 0o600 });
        await rename(temporary, statePath);
      }
      break;
    case 'dev':
      noRemaining();
      await run('docker', ['compose', '--env-file', '.env.runtime', '-f', 'compose.dev.yaml', 'up', '--build']);
      break;
    case 'down': noRemaining(); await run('docker', [...composeArguments(), 'down']); break;
    case 'migrate':
      noRemaining();
      await run('docker', [...composeArguments(), 'run', '--rm', 'app', 'node', 'scripts/selfhost.mjs', 'migrate']);
      break;
    case 'bootstrap-owner':
      await run('docker', [...composeArguments(), 'run', '--rm', 'app', 'node', 'scripts/selfhost.mjs', 'bootstrap-owner', ...argumentsCopy]);
      break;
    default: throw new Error('Usage: node scripts/pipeline.mjs install|verify|agent|image|smoke|up|dev|down|migrate|bootstrap-owner [--image name:tag] [--dev|--production] [--migrate]');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
