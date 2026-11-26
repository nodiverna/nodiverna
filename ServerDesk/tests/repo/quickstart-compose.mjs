// deploy/quickstart/compose.yaml, the short file of the README quick start: its
// size, services, volumes and image; the four secrets only as required
// interpolations without defaults; PORTAL_HOST; the hardening and the migrate
// step before the app; db, ca-export, proxy and the Caddy config equal to
// compose.yaml; and, with docker compose, how `config` resolves it with and
// without the .env from `selfhost.mjs secrets`.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { serverDeskRoot as root } from '../support/paths.mjs';

const require = createRequire(import.meta.url);
// js-yaml is an existing ESLint dependency, not a new application dependency.
const yaml = createRequire(require.resolve('eslint/package.json'))('js-yaml');
const quickstartFile = path.join(root, 'deploy', 'quickstart', 'compose.yaml');
const text = (await readFile(quickstartFile, 'utf8')).replaceAll('\r\n', '\n');
const quickstart = yaml.load(text);
const production = yaml.load(await readFile(path.join(root, 'compose.yaml'), 'utf8'));
const { app, migrate, db, proxy } = quickstart.services;
const secretNames = ['SESSION_SECRET', 'PASSWORD_PEPPER', 'AGENT_JOB_SIGNING_KEY', 'DATABASE_PASSWORD'];
const dockerCompose = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0;
const networkNames = service => {
  const networks = service?.networks;
  if (!networks) return [];
  return (Array.isArray(networks) ? networks : Object.keys(networks)).map(String).sort();
};

test('the quick-start file is short, has a short header and the same project, services and volumes', () => {
  const lines = text.trimEnd().split('\n');
  assert.ok(lines.length <= 120, `at most 120 lines, has ${lines.length}`);
  const header = lines.slice(0, lines.findIndex(line => !line.startsWith('#')));
  assert.ok(header.length >= 1 && header.length <= 5, 'a header comment of at most 5 lines');
  assert.match(header.join(' '), /README/);
  assert.match(header.join(' '), /docs\/self-hosting\.md/);
  assert.equal(quickstart.name, 'serverdesk');
  assert.deepEqual(Object.keys(quickstart.services).sort(), ['app', 'ca-export', 'db', 'migrate', 'proxy']);
  assert.deepEqual(Object.keys(quickstart.volumes).sort(), ['app-data', 'caddy-config', 'caddy-data', 'db-data', 'portal-ca']);
  assert.deepEqual(Object.keys(quickstart.volumes).sort(), Object.keys(production.volumes).sort(), 'the volume names of compose.yaml');
  for (const service of [app, migrate]) assert.equal(service.image, '${SERVERDESK_IMAGE:-ghcr.io/nodiverna/nodiverna:latest}');
  for (const [name, service] of Object.entries(quickstart.services)) assert.equal(service.build, undefined, `${name} does not build`);
});

test('the secrets come only from .env as required values, without a default or placeholder', () => {
  assert.ok(!/env_file/.test(text), 'no env_file');
  assert.ok(!text.includes('REPLACE_WITH'), 'no placeholder secret');
  for (const name of secretNames) {
    const uses = [...text.matchAll(new RegExp(`\\$\\{${name}([^}]*)\\}`, 'g'))];
    assert.ok(uses.length > 0, `${name} is used`);
    for (const [, rest] of uses) {
      assert.ok(rest.startsWith(':?'), `${name} is always required (\${${name}:?...})`);
      assert.match(rest, /README quick start, step 2/, `the message of ${name} names the fix`);
    }
    assert.ok(!new RegExp(`^\\s*${name}\\s*[:=]\\s*[^$\\s]`, 'm').test(text), `${name} has no literal value`);
  }
  for (const service of [app, migrate]) {
    for (const name of secretNames) assert.match(service.environment[name], new RegExp(`^\\$\\{${name}:\\?`));
  }
  assert.match(db.environment.POSTGRES_PASSWORD, /^\$\{DATABASE_PASSWORD:\?/);
});

test('PORTAL_HOST sets the portal address of app and proxy, with ports 8080 and 8443', () => {
  assert.equal(app.environment.SITE_ORIGIN, 'https://${PORTAL_HOST:-localhost}:8443');
  assert.deepEqual(proxy.environment, {
    CADDY_ADDRESS: 'https://${PORTAL_HOST:-localhost}',
    CADDY_SERVER_NAME: '${PORTAL_HOST:-localhost}',
    SITE_ORIGIN: 'https://${PORTAL_HOST:-localhost}:8443',
    CADDY_TLS: 'internal',
  });
  assert.deepEqual(proxy.ports, ['8080:80', '8443:443']);
});

test('app and migrate share the environment, volumes, networks and hardening', () => {
  for (const service of [app, migrate]) {
    assert.equal(service.environment.DATABASE_URL, 'postgres://serverdesk@db:5432/serverdesk');
    assert.equal(service.environment.TRUSTED_CLIENT_IP_HEADER, 'x-serverdesk-client-ip');
    assert.equal(service.environment.PORTAL_CA_FILE, '/portal-ca/root.crt');
    assert.deepEqual(service.volumes, ['app-data:/data', 'portal-ca:/portal-ca:ro']);
    assert.deepEqual(networkNames(service), ['database', 'default']);
    assert.deepEqual(service.security_opt, ['no-new-privileges:true']);
    assert.deepEqual(service.cap_drop, ['ALL']);
  }
  assert.deepEqual(migrate.environment, app.environment);
});

test('migrate runs before the app, at each up, and the app publishes no port', () => {
  assert.deepEqual(migrate.command, ['node', 'scripts/selfhost.mjs', 'migrate'], 'migrate with its automatic backup (no --skip-backup)');
  assert.equal(migrate.restart, 'no');
  assert.deepEqual(migrate.depends_on, { db: { condition: 'service_healthy' } });
  assert.equal(app.restart, 'unless-stopped');
  assert.equal(app.init, true);
  assert.deepEqual(app.expose, ['3000']);
  assert.equal(app.ports, undefined, 'the app has no published port');
  assert.deepEqual(app.depends_on, { db: { condition: 'service_healthy' }, migrate: { condition: 'service_completed_successfully' } });
});

test('db, ca-export, proxy and the Caddy config are the ones of compose.yaml', () => {
  const withoutPassword = service => ({ ...service, environment: { ...service.environment, POSTGRES_PASSWORD: undefined } });
  assert.deepEqual(withoutPassword(db), withoutPassword(production.services.db));
  assert.deepEqual(quickstart.services['ca-export'], production.services['ca-export']);
  const withoutAddress = service => Object.fromEntries(Object.entries(service).filter(([key]) => !['environment', 'ports'].includes(key)));
  assert.deepEqual(withoutAddress(proxy), withoutAddress(production.services.proxy));
  assert.equal(quickstart.configs.caddyfile.content, production.configs.caddyfile.content);
});

test('the database network is internal and only db and the app image join it', () => {
  assert.equal(quickstart.networks.database.internal, true);
  assert.deepEqual(networkNames(db), ['database']);
  assert.deepEqual(networkNames(proxy), [], 'the proxy is only on default');
  assert.equal(quickstart.services['ca-export'].network_mode, 'none');
});

test('docker compose needs the generated .env and resolves PORTAL_HOST', { skip: !dockerCompose && 'docker compose is not available' }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'serverdesk-quickstart-'));
  try {
    await copyFile(quickstartFile, path.join(directory, 'compose.yaml'));
    const environment = { ...process.env };
    for (const name of [...secretNames, 'SERVERDESK_IMAGE', 'PORTAL_HOST', 'CADDY_TLS', 'COMPOSE_FILE', 'COMPOSE_PROJECT_NAME']) delete environment[name];
    const config = () => spawnSync('docker', ['compose', 'config', '--format', 'json'], { cwd: directory, env: environment, encoding: 'utf8' });

    const missing = config();
    assert.notEqual(missing.status, 0, 'config fails without .env');
    assert.match(missing.stderr, /required variable (SESSION_SECRET|PASSWORD_PEPPER|AGENT_JOB_SIGNING_KEY|DATABASE_PASSWORD) is missing/);
    assert.match(missing.stderr, /README quick start, step 2/);

    const secrets = spawnSync(process.execPath, [path.join(root, 'scripts', 'selfhost.mjs'), 'secrets'], { encoding: 'utf8' });
    assert.equal(secrets.status, 0, secrets.stderr);
    await writeFile(path.join(directory, '.env'), secrets.stdout);
    const local = config();
    assert.equal(local.status, 0, local.stderr);
    const resolved = JSON.parse(local.stdout);
    assert.equal(resolved.name, 'serverdesk');
    assert.equal(resolved.services.app.image, 'ghcr.io/nodiverna/nodiverna:latest');
    assert.equal(resolved.services.migrate.image, 'ghcr.io/nodiverna/nodiverna:latest');
    assert.equal(resolved.services.app.environment.SITE_ORIGIN, 'https://localhost:8443');
    assert.equal(resolved.services.proxy.environment.CADDY_ADDRESS, 'https://localhost');
    assert.equal(resolved.networks.database.internal, true);

    await writeFile(path.join(directory, '.env'), `${secrets.stdout}PORTAL_HOST=192.168.1.10\n`);
    const lan = config();
    assert.equal(lan.status, 0, lan.stderr);
    const { app: lanApp, proxy: lanProxy } = JSON.parse(lan.stdout).services;
    assert.equal(lanApp.environment.SITE_ORIGIN, 'https://192.168.1.10:8443');
    assert.equal(lanProxy.environment.SITE_ORIGIN, 'https://192.168.1.10:8443');
    assert.equal(lanProxy.environment.CADDY_ADDRESS, 'https://192.168.1.10');
    assert.equal(lanProxy.environment.CADDY_SERVER_NAME, '192.168.1.10');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
