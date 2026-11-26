import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The configuration rules of a Container Apps app or job: one application
 * container, a PostgreSQL DATABASE_URL to a non-local host with TLS
 * (sslmode=require or verify-full) and without a password, DATABASE_PASSWORD
 * and the other secrets as configured secretRefs, shared Blob storage and an
 * HTTPS origin. Throws with a clear message; returns the container env.
 */
export function containerRuntime(resource, label) {
  const containers = resource.properties?.template?.containers;
  if (!Array.isArray(containers) || containers.length !== 1) throw new Error(`${label}: expected exactly one application container.`);
  const env = Object.fromEntries((containers[0].env || []).map(value => [value.name, value]));
  const value = name => env[name]?.value || '';
  let url;
  try { url = new URL(value('DATABASE_URL')); } catch { throw new Error(`${label}: configure DATABASE_URL as postgres://user@host:5432/database?sslmode=require; keep the password in the DATABASE_PASSWORD secretRef.`); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error(`${label}: DATABASE_URL must be a PostgreSQL URL (postgres://), for example Azure Database for PostgreSQL.`);
  if (['localhost', '127.0.0.1', '[::1]', 'db'].includes(url.hostname)) throw new Error(`${label}: Container Apps needs a reachable external PostgreSQL server; a local database host is forbidden here.`);
  if (!['require', 'verify-full'].includes(url.searchParams.get('sslmode') ?? '')) throw new Error(`${label}: DATABASE_URL needs TLS: add sslmode=require or sslmode=verify-full.`);
  if (url.password) throw new Error(`${label}: DATABASE_URL must not contain a password; use the DATABASE_PASSWORD secretRef.`);
  if (value('OBJECT_STORAGE_DRIVER') !== 'azure' || !value('AZURE_STORAGE_CONTAINER')) throw new Error(`${label}: configure shared Azure Blob storage.`);
  if (!value('AZURE_STORAGE_ACCOUNT_URL').startsWith('https://')) throw new Error(`${label}: configure AZURE_STORAGE_ACCOUNT_URL with HTTPS.`);
  const secrets = new Set((resource.properties.configuration.secrets || []).map(secret => secret.name));
  for (const name of ['SESSION_SECRET', 'PASSWORD_PEPPER', 'AGENT_JOB_SIGNING_KEY']) {
    if (!env[name]?.secretRef || !secrets.has(env[name].secretRef)) throw new Error(`${label}: ${name} must use a configured Container Apps secretRef.`);
  }
  if (!env.DATABASE_PASSWORD?.secretRef || !secrets.has(env.DATABASE_PASSWORD.secretRef)) {
    throw new Error(`${label}: DATABASE_PASSWORD must use a configured Container Apps secretRef.`);
  }
  const connectionString = env.AZURE_STORAGE_CONNECTION_STRING;
  if (connectionString) {
    if (!connectionString.secretRef || !secrets.has(connectionString.secretRef)) throw new Error(`${label}: storage connection string must use a secretRef.`);
  } else if (!/SystemAssigned|UserAssigned/.test(resource.identity?.type || '')) {
    throw new Error(`${label}: configure a Managed Identity with Storage Blob Data Contributor, or a storage connection string secretRef.`);
  }
  if (!value('SITE_ORIGIN').startsWith('https://')) throw new Error(`${label}: configure SITE_ORIGIN as the final HTTPS origin.`);
  return { env, container: containers[0], value };
}
/** The migration job runs migrate, on Azure usually with --skip-backup (the server has point-in-time restore). */
export function migrationCommandAllowed(command) {
  return ['["node","scripts/selfhost.mjs","migrate"]', '["node","scripts/selfhost.mjs","migrate","--skip-backup"]'].includes(JSON.stringify(command));
}

async function main() {
  const args = process.argv.slice(2);
  function option(name, fallback = '') {
    const at = args.indexOf(name);
    if (at < 0) return fallback;
    const value = args[at + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing ${name} value.`);
    args.splice(at, 2);
    return value;
  }
  const resourceGroup = option('--resource-group', process.env.AZURE_RESOURCE_GROUP);
  const appName = option('--app', process.env.AZURE_CONTAINER_APP);
  const image = option('--image', process.env.SERVERDESK_IMAGE);
  const maxReplicas = option('--max-replicas', '3');
  const migrationJob = option('--migration-job');
  if (args.length) throw new Error(`Unexpected arguments: ${args.join(' ')}`);
  if (!resourceGroup || !appName || !image) throw new Error('--resource-group, --app and --image are required.');
  if (!/^[A-Za-z0-9][A-Za-z0-9./:_-]*$/.test(image)) throw new Error('Invalid image reference.');
  if (!/^\d+$/.test(maxReplicas) || Number(maxReplicas) < 1 || Number(maxReplicas) > 100) throw new Error('--max-replicas must be 1..100.');
  if (process.platform === 'win32') throw new Error('Run this Azure rollout on Linux or WSL.');

  function az(command, json = true) {
    const output = execFileSync('az', [...command, '--only-show-errors', '--output', json ? 'json' : 'none'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: 180_000,
    });
    return json ? JSON.parse(output) : undefined;
  }
  const appScope = ['--resource-group', resourceGroup, '--name', appName];
  const app = az(['containerapp', 'show', ...appScope]);
  const application = containerRuntime(app, 'App');
  if (app.properties.configuration.activeRevisionsMode !== 'Single') {
    throw new Error('App: configure Single revision mode before this rollout, so the ready release receives traffic.');
  }
  const ingress = app.properties.configuration.ingress;
  if (!ingress || ingress.targetPort !== 3000 || ingress.allowInsecure === true) throw new Error('App: HTTPS ingress to port 3000 is required.');
  for (const [type, endpoint] of [['Startup', 'live'], ['Liveness', 'live'], ['Readiness', 'ready']]) {
    if (!(application.container.probes || []).some(probe => probe.type === type && probe.httpGet?.path === `/api/health/${endpoint}` && probe.httpGet?.port === 3000)) {
      throw new Error(`App: configure ${type} HTTP probe /api/health/${endpoint} on port 3000 before rollout.`);
    }
  }

  // Migrations run once in an explicitly selected, pre-provisioned manual Job.
  // Never run them in the web container entrypoint or silently on every replica.
  if (migrationJob) {
    const scope = ['--resource-group', resourceGroup, '--name', migrationJob];
    const job = az(['containerapp', 'job', 'show', ...scope]);
    const migration = containerRuntime(job, 'Migration Job');
    if (job.properties.configuration.triggerType !== 'Manual') throw new Error('Migration Job must use Manual trigger.');
    for (const name of ['DATABASE_URL', 'OBJECT_STORAGE_DRIVER', 'AZURE_STORAGE_ACCOUNT_URL', 'AZURE_STORAGE_CONTAINER', 'SITE_ORIGIN']) {
      if (migration.value(name) !== application.value(name)) throw new Error(`Migration Job: ${name} must match the App.`);
    }
    const command = [...(migration.container.command || []), ...(migration.container.args || [])];
    if (!migrationCommandAllowed(command)) {
      throw new Error('Migration Job command/args must be: node scripts/selfhost.mjs migrate [--skip-backup]');
    }
    const executions = az(['containerapp', 'job', 'execution', 'list', ...scope]);
    if (executions.some(execution => ['Running', 'Pending'].includes(execution.properties?.status))) throw new Error('A migration Job execution is already running.');
    console.log('Running explicitly requested database migration Job.');
    az(['containerapp', 'job', 'update', ...scope, '--image', image, '--parallelism', '1', '--replica-completion-count', '1', '--replica-retry-limit', '0', '--replica-timeout', '1800'], false);
    const execution = az(['containerapp', 'job', 'start', ...scope]);
    const deadline = Date.now() + 30 * 60_000;
    let succeeded = false;
    while (Date.now() < deadline) {
      const runs = az(['containerapp', 'job', 'execution', 'list', ...scope]);
      const status = runs.find(run => run.name === execution.name)?.properties?.status;
      if (status === 'Succeeded') { succeeded = true; break; }
      if (['Failed', 'Stopped', 'Degraded'].includes(status)) throw new Error(`Migration execution ${execution.name} ended with ${status}. App rollout aborted.`);
      await new Promise(resolve => setTimeout(resolve, 15_000));
    }
    if (!succeeded) throw new Error('Migration Job timeout. App rollout aborted; inspect Job before retrying.');
  }

  console.log(`Deploying ${image} to ${appName}; 1..${maxReplicas} replicas.`);
  const update = az(['containerapp', 'update', ...appScope, '--image', image, '--min-replicas', '1', '--max-replicas', maxReplicas,
    '--scale-rule-name', 'http', '--scale-rule-type', 'http', '--scale-rule-http-concurrency', '20']);
  const expectedRevision = update.properties.latestRevisionName;
  const deadline = Date.now() + 10 * 60_000;
  let ready = false;
  while (Date.now() < deadline) {
    const current = az(['containerapp', 'show', ...appScope]);
    if (current.properties.provisioningState === 'Failed') throw new Error('Azure rollout provisioning failed.');
    if (current.properties.latestReadyRevisionName === expectedRevision) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 15_000));
  }
  if (!ready) throw new Error(`Revision ${expectedRevision} did not become ready. Inspect health probes and logs.`);
  console.log(`Ready revision: ${expectedRevision}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
