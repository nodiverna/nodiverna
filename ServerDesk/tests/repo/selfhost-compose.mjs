import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { existsSync, openSync, readSync, closeSync, readdirSync } from 'node:fs';
import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { serverDeskRoot, repositoryRoot } from '../support/paths.mjs';

// Public self-hosting: one compose.yaml with the GHCR image and
// inline Caddy config, the env template, the image workflow, and no private
// NAS tooling or traces left in the public tree.
const root = serverDeskRoot;
const repository = repositoryRoot;
const require = createRequire(import.meta.url);
// js-yaml is an existing ESLint dependency, not a new application dependency.
const yaml = createRequire(require.resolve('eslint/package.json'))('js-yaml');
const publishedImage = '${SERVERDESK_IMAGE:-ghcr.io/nodiverna/nodiverna:latest}';
const lf = text => text.replaceAll('\r\n', '\n').trim();
const composeText = await readFile(path.join(root, 'compose.yaml'), 'utf8');
const compose = yaml.load(composeText);
const caddyfile = lf(await readFile(path.join(root, 'deploy', 'Caddyfile'), 'utf8'));
const dockerCompose = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0;
// The network names of a service, from the list or the map form, sorted.
const networkNames = service => {
  const networks = service?.networks;
  if (!networks) return [];
  return (Array.isArray(networks) ? networks : Object.keys(networks)).map(String).sort();
};
// The resolved `docker compose config` JSON: db only on the internal network
// <project>_database, the app-image services also on default, the proxy only on default.
const assertResolvedNetworks = (resolved, project, appImageServices) => {
  assert.equal(resolved.networks.database.name, `${project}_database`);
  assert.equal(resolved.networks.database.internal, true, `${project}_database is internal`);
  assert.notEqual(resolved.networks.default?.internal, true, 'the default network keeps outbound access');
  assert.deepEqual(networkNames(resolved.services.db), ['database'], 'db is only on database');
  for (const name of appImageServices) assert.deepEqual(networkNames(resolved.services[name]), ['database', 'default'], `${name} is on default and database`);
  assert.deepEqual(networkNames(resolved.services.proxy), ['default'], 'the proxy is only on default');
  for (const [name, service] of Object.entries(resolved.services)) {
    if (!['db', ...appImageServices].includes(name)) assert.ok(!networkNames(service).includes('database'), `${name} is not on database`);
  }
};

test('compose.yaml runs the published image on its own and keeps project, volumes, ports and hardening', () => {
  assert.equal(compose.name, 'serverdesk');
  const { app, proxy } = compose.services;
  assert.equal(app.build, undefined, 'compose.yaml never builds');
  assert.equal(app.image, publishedImage);
  assert.equal(app.env_file, '.env.runtime');
  assert.deepEqual(app.volumes, ['app-data:/data', 'portal-ca:/portal-ca:ro']);
  assert.equal(app.environment.PORTAL_CA_FILE, '/portal-ca/root.crt');
  assert.deepEqual(app.security_opt, ['no-new-privileges:true']);
  assert.deepEqual(app.cap_drop, ['ALL']);
  assert.ok(!(['ALLOW', 'LEGACY', 'ACTIVATION'].join('_') in app.environment), 'the removed legacy activation switch is not set');
  assert.deepEqual(Object.keys(compose.volumes).sort(), ['app-data', 'caddy-config', 'caddy-data', 'db-data', 'portal-ca']);
  assert.deepEqual(app.depends_on, { db: { condition: 'service_healthy' } }, 'the app starts after a healthy database');
  assert.equal(app.environment.DATABASE_URL, '${DATABASE_URL:-postgres://serverdesk@db:5432/serverdesk}');
  assert.deepEqual(proxy.configs, [{ source: 'caddyfile', target: '/etc/caddy/Caddyfile' }]);
  assert.deepEqual(proxy.volumes, ['caddy-data:/data', 'caddy-config:/config']);
  assert.ok(!proxy.volumes.some(volume => String(volume.source ?? volume).startsWith('./deploy')), 'no bind mount on ./deploy');
  assert.deepEqual(proxy.ports, ['${CADDY_HTTP_PORT:-8080}:80', '${CADDY_HTTPS_PORT:-8443}:443']);
  assert.deepEqual(proxy.depends_on, { app: { condition: 'service_healthy' } });
});

// The portal runs maintenance itself (runtime/maintenance-scheduler.mjs):
// compose.yaml has no maintenance service, profile or comment about one.
test('compose.yaml runs exactly app, ca-export, db and proxy, without a maintenance service or profile', async () => {
  assert.deepEqual(Object.keys(compose.services).sort(), ['app', 'ca-export', 'db', 'proxy']);
  assert.ok(Object.values(compose.services).every(service => service.profiles === undefined), 'no service has a profile');
  assert.doesNotMatch(composeText, /COMPOSE_PROFILES|profiles:|selfhost\.mjs maintenance|service "maintenance"/, 'no maintenance service, profile or anchor comment');
  const template = await readFile(path.join(root, 'deploy', 'runtime.env.example'), 'utf8');
  assert.doesNotMatch(template, /COMPOSE_PROFILES/, 'the env template offers no maintenance profile');
});

// ca-export copies only Caddy's public root certificate into the volume the app
// mounts read-only (lib/server/agent/portal-certificate.ts); same image as the proxy, no network.
test('compose.yaml and compose.dev.yaml export only the public Caddy root to the app, without network or capabilities', async () => {
  const development = yaml.load(await readFile(path.join(root, 'compose.dev.yaml'), 'utf8'));
  for (const [file, definition, caddyData, portalCa, appData] of [['compose.yaml', compose, 'caddy-data', 'portal-ca', 'app-data'], ['compose.dev.yaml', development, 'dev-caddy-data', 'dev-portal-ca', 'dev-data']]) {
    const exporter = definition.services['ca-export'];
    assert.ok(exporter, `${file} has ca-export`);
    assert.equal(exporter.image, 'caddy:2.10-alpine', `${file}: the proxy image, no extra pull`);
    assert.equal(exporter.image, definition.services.proxy.image, `${file}: same image as the proxy`);
    assert.equal(exporter.init, true, file);
    assert.equal(exporter.restart, 'unless-stopped', file);
    assert.equal(exporter.network_mode, 'none', `${file}: no network`);
    assert.equal(exporter.read_only, true, `${file}: read-only root filesystem`);
    assert.equal(exporter.tmpfs, undefined, `${file}: no tmpfs, the script writes only to /export`);
    assert.equal(exporter.networks, undefined, file);
    assert.equal(exporter.ports, undefined, file);
    assert.deepEqual(exporter.cap_drop, ['ALL'], file);
    assert.deepEqual(exporter.security_opt, ['no-new-privileges:true'], file);
    assert.deepEqual(exporter.environment, { CADDY_TLS: '${CADDY_TLS:-internal}' }, file);
    assert.deepEqual(exporter.volumes, [`${caddyData}:/caddy:ro`, `${portalCa}:/export`], `${file}: Caddy data read-only, the export volume writable`);
    assert.deepEqual(exporter.depends_on, ['proxy'], file);
    assert.ok(definition.services.proxy.volumes.includes(`${caddyData}:/data`), `${file}: the proxy keeps its data in ${caddyData}`);
    const [shell, flag, script] = exporter.command;
    assert.deepEqual([shell, flag], ['/bin/sh', '-c'], file);
    assert.ok(!script.replaceAll('$$', '').includes('$'), `${file}: every $ is escaped as $$`);
    assert.match(script, /"\$\$CADDY_TLS" = internal/, `${file}: only with tls internal`);
    assert.match(script, /source=\/caddy\/caddy\/pki\/authorities\/local\/root\.crt\n/, `${file}: the source is Caddy's root.crt`);
    assert.match(script, /cp "\$\$source" \/export\/root\.crt\.tmp && chmod 0644 \/export\/root\.crt\.tmp && mv -f \/export\/root\.crt\.tmp \/export\/root\.crt/, `${file}: temp file, mode 0644, then mv`);
    assert.match(script, /if ! cmp -s "\$\$source" \/export\/root\.crt; then/, `${file}: copies only when the content differs`);
    assert.match(script, /else\n\s+rm -f \/export\/root\.crt/, `${file}: otherwise the copy is removed`);
    assert.match(script, /sleep 60\n/, `${file}: every 60 seconds`);
    assert.doesNotMatch(script, /root\.key|\.key\b|intermediate|\*/i, `${file}: never the private key, the intermediate or a wildcard`);
    assert.deepEqual([...script.matchAll(/\/[\w./-]+/g)].map(match => match[0]).filter(value => value.startsWith('/caddy')), ['/caddy/caddy/pki/authorities/local/root.crt'], `${file}: only root.crt is read from Caddy's data`);
    const app = definition.services.app;
    assert.ok(app.volumes.includes(`${portalCa}:/portal-ca:ro`), `${file}: the app mounts the export read-only`);
    assert.ok(app.volumes.includes(`${appData}:/data`), file);
    assert.ok(!app.volumes.some(volume => String(volume).startsWith(caddyData)), `${file}: the app never mounts Caddy's data`);
    assert.equal(app.environment.PORTAL_CA_FILE, '/portal-ca/root.crt', file);
    assert.ok(Object.hasOwn(definition.volumes, portalCa), `${file} declares ${portalCa}`);
    for (const [name, service] of Object.entries(definition.services)) if (name !== 'ca-export' && name !== 'app') assert.ok(!(service.volumes ?? []).some(volume => String(volume).startsWith(portalCa + ':')), `${file}: only ca-export and app use ${portalCa}`);
  }
  assert.deepEqual(development.services.app.volumes, ['.:/app', 'dev-node-modules:/app/node_modules', 'dev-next:/app/.next', 'dev-data:/data', 'dev-portal-ca:/portal-ca:ro']);
});

test('the inline Caddy config is deploy/Caddyfile with $$ escapes and nothing Compose would interpolate', () => {
  const content = compose.configs.caddyfile.content;
  assert.equal(lf(content.replaceAll('$$', '$')), caddyfile);
  assert.ok(!content.replaceAll('$$', '').includes('$'), 'every $ is escaped as $$');
  assert.ok(caddyfile.includes('{$CADDY_SERVER_NAME:localhost}'));
});

test('docker compose accepts compose.yaml alone in an empty directory', { skip: !dockerCompose && 'docker compose is not available' }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'serverdesk-compose-'));
  try {
    await copyFile(path.join(root, 'compose.yaml'), path.join(directory, 'compose.yaml'));
    await copyFile(path.join(root, 'deploy', 'runtime.env.example'), path.join(directory, '.env.runtime'));
    const environment = { ...process.env };
    delete environment.SERVERDESK_IMAGE;
    const config = env => {
      const result = spawnSync('docker', ['compose', '-f', 'compose.yaml', '--env-file', '.env.runtime', 'config', '--format', 'json'], { cwd: directory, env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    const resolved = config(environment);
    assert.equal(resolved.services.app.image, 'ghcr.io/nodiverna/nodiverna:latest');
    // `config` prints a literal $ escaped as $$ again so its output stays valid
    // Compose input. Undo that: the result must be the unchanged Caddyfile.
    const content = resolved.configs.caddyfile.content;
    assert.ok(content.includes('{$$CADDY_SERVER_NAME:localhost}'), 'Compose kept the Caddy placeholder literally');
    assert.ok(content.replaceAll('$$', '$').includes('{$CADDY_SERVER_NAME:localhost}'));
    assert.equal(lf(content.replaceAll('$$', '$')), caddyfile);
    assert.equal(config({ ...environment, SERVERDESK_IMAGE: 'serverdesk:local' }).services.app.image, 'serverdesk:local');
    assert.deepEqual(Object.keys(resolved.services).sort(), ['app', 'ca-export', 'db', 'proxy'], 'the project has exactly app, ca-export, db and proxy');
    assert.equal(resolved.services['ca-export'].network_mode, 'none');
    assert.equal(resolved.services['ca-export'].read_only, true, 'ca-export runs with a read-only root filesystem');
    assert.ok(resolved.services['ca-export'].command.at(-1).includes('$CADDY_TLS'), 'the shell, not Compose, reads CADDY_TLS');
    assertResolvedNetworks(resolved, 'serverdesk', ['app']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('docker compose resolves compose.dev.yaml with db only on the internal network', { skip: !dockerCompose && 'docker compose is not available' }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'serverdesk-compose-dev-'));
  try {
    await copyFile(path.join(root, 'compose.dev.yaml'), path.join(directory, 'compose.dev.yaml'));
    await writeFile(path.join(directory, '.env.runtime'), 'DATABASE_PASSWORD=compose-config-test\n');
    const result = spawnSync('docker', ['compose', '-f', 'compose.dev.yaml', '--env-file', '.env.runtime', 'config', '--format', 'json'], { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const resolved = JSON.parse(result.stdout);
    assert.equal(resolved.name, 'serverdesk-dev');
    assert.deepEqual(Object.keys(resolved.services).sort(), ['app', 'ca-export', 'db', 'proxy']);
    assert.equal(resolved.services['ca-export'].network_mode, 'none');
    assert.equal(resolved.services['ca-export'].read_only, true, 'ca-export runs with a read-only root filesystem');
    assertResolvedNetworks(resolved, 'serverdesk-dev', ['app']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('deploy/runtime.env.example is the general env template without the private NAS address', async () => {
  const template = await readFile(path.join(root, 'deploy', 'runtime.env.example'), 'utf8');
  for (const key of ['SESSION_SECRET=', 'PASSWORD_PEPPER=', 'AGENT_JOB_SIGNING_KEY=', 'SITE_ORIGIN=']) assert.match(template, new RegExp(`^${key}`, 'm'));
  assert.ok(!template.includes(['192', '168', '178', '5'].join('.')));
  assert.match(template.split('\n')[0], /docker compose --env-file \.env\.runtime/);
  assert.match(template, /192\.168\.1\.10/);
  assert.doesNotMatch(template, /COMPOSE_PROFILES=maintenance/, 'no maintenance profile');
});

test('the image workflow runs only by hand, plans the release first, smoke-tests before login and tags only after the push', async () => {
  const workflow = yaml.load(await readFile(path.join(repository, '.github', 'workflows', 'docker-image.yml'), 'utf8'));
  // Only workflow_dispatch with the release choice; the tag push trigger is gone.
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs), ['release']);
  const input = workflow.on.workflow_dispatch.inputs.release;
  assert.equal(input.type, 'choice'); assert.deepEqual(input.options, ['patch', 'minor', 'none']); assert.equal(input.default, 'patch');
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(workflow.concurrency, { group: 'docker-image', 'cancel-in-progress': false }, 'one fixed group: releases never run in parallel');
  // A fixed full reference: the login registry must match it.
  assert.equal(workflow.env.IMAGE, 'ghcr.io/nodiverna/nodiverna');
  assert.deepEqual(Object.keys(workflow.jobs), ['publish', 'release']);
  // The GITHUB_TOKEN pushes the image: packages: write only on publish, no environment and no secret.
  assert.equal(workflow.jobs.publish.environment, undefined);
  assert.equal(workflow.jobs.release.environment, undefined);
  assert.deepEqual(workflow.jobs.publish.permissions, { contents: 'read', packages: 'write' });
  const rawText = await readFile(path.join(repository, '.github', 'workflows', 'docker-image.yml'), 'utf8');
  for (const word of ['DOCKERHUB', 'docker-hub', 'docker.io', 'Docker Hub']) assert.ok(!rawText.includes(word), `no ${word} in the workflow`);
  const allSteps = Object.values(workflow.jobs).flatMap(job => job.steps);
  const steps = workflow.jobs.publish.steps;
  const index = predicate => steps.findIndex(predicate);
  const uses = name => step => step.uses?.startsWith(`${name}@`);
  const usedActions = allSteps.filter(step => step.uses).map(step => step.uses);
  assert.deepEqual([...new Set(usedActions.map(value => value.split('@')[0]))].sort(), [
    'actions/checkout', 'actions/setup-node', 'docker/build-push-action', 'docker/login-action',
    'docker/metadata-action', 'docker/setup-buildx-action', 'docker/setup-qemu-action',
  ]);
  // Every action is pinned to a commit SHA with a version comment (see also tests/repo/ci-workflow.mjs),
  // and checkout and setup-node use the same commits as the agent release.
  for (const value of usedActions) assert.match(value, /^[a-z0-9-]+\/[a-z0-9-]+@[0-9a-f]{40}$/, value);
  const workflowText = (await readFile(path.join(repository, '.github', 'workflows', 'docker-image.yml'), 'utf8')).replaceAll('\r\n', '\n');
  for (const line of workflowText.split('\n').filter(text => /^\s*(?:-\s+)?uses:/.test(text))) assert.match(line, /@[0-9a-f]{40} # v\d+\.\d+\.\d+$/, line);
  const agentRelease = yaml.load(await readFile(path.join(repository, '.github', 'workflows', 'agent-release.yml'), 'utf8'));
  const agentUses = new Set(Object.values(agentRelease.jobs).flatMap(job => job.steps).filter(step => step.uses).map(step => step.uses));
  for (const name of ['actions/checkout', 'actions/setup-node']) {
    const pinned = [...new Set(usedActions.filter(value => value.startsWith(`${name}@`)))];
    assert.equal(pinned.length, 1, name);
    assert.ok(agentUses.has(pinned[0]), `${name} uses the commit of agent-release.yml`);
  }
  assert.deepEqual(steps[0].with, { 'fetch-depth': 0, 'persist-credentials': false }, 'full history and tags, no stored credentials');
  assert.ok(uses('actions/checkout')(steps[0]) && uses('actions/setup-node')(steps[1]));
  assert.equal(steps[1].with['node-version'], 22);
  // The plan runs right after checkout and Node setup, before any build.
  const plan = index(step => step.id === 'plan');
  assert.equal(plan, 2);
  assert.equal(steps[plan].run, 'node scripts/app-release.mjs plan --bump "$RELEASE" --image "$IMAGE"');
  assert.equal(steps[plan]['working-directory'], 'ServerDesk');
  assert.deepEqual(steps[plan].env, { RELEASE: '${{ inputs.release }}' });
  assert.equal(workflow.jobs.publish.outputs.agent_version, undefined, 'the image holds no agent, so there is no agent version');
  for (const name of ['version', 'tag', 'previous_tag', 'release', 'notes']) assert.equal(workflow.jobs.publish.outputs[name], `\${{ steps.plan.outputs.${name} }}`, name);
  const local = steps.find(step => uses('docker/build-push-action')(step) && step.with.load === true);
  assert.ok(plan < steps.indexOf(local) && plan < index(uses('docker/setup-qemu-action')), 'plan before the first build');
  // A version that the registry has already stops the run after the plan and before the first build.
  const registryCheck = index(step => step.name === 'Check the registry for the version');
  assert.ok(plan < registryCheck && registryCheck < index(uses('docker/build-push-action')), 'the registry check comes after the plan and before the first build');
  assert.equal(steps[registryCheck].if, "steps.plan.outputs.release == 'true'");
  assert.equal(steps[registryCheck].run, 'node scripts/app-release.mjs check-registry --image "$IMAGE" --version "$VERSION"');
  assert.equal(steps[registryCheck]['working-directory'], 'ServerDesk');
  assert.deepEqual(steps[registryCheck].env, { VERSION: '${{ steps.plan.outputs.version }}', REGISTRY_USERNAME: '${{ github.actor }}', REGISTRY_TOKEN: '${{ github.token }}' });
  // The online dependency audit runs after the plan and before QEMU and any build.
  const audits = steps.filter(step => /\bpnpm check:audit\b/.test(step.run ?? ''));
  assert.equal(audits.length, 1, 'exactly one step runs pnpm check:audit');
  const [audit] = audits;
  const auditIndex = steps.indexOf(audit);
  assert.ok(auditIndex > plan, 'the audit runs after the plan');
  assert.ok(auditIndex < index(uses('docker/setup-qemu-action')), 'the audit runs before Set up QEMU');
  assert.ok(auditIndex < index(uses('docker/build-push-action')), 'the audit runs before the first build');
  assert.equal(audit.name, 'Audit dependencies');
  assert.equal(audit['working-directory'], 'ServerDesk');
  assert.match(audit.run, /\bcorepack enable\b/);
  assert.equal(audit.uses, undefined, 'the audit uses no action');
  assert.ok(!audit.run.includes('--ignore-registry-errors'), 'a registry error stops the run');
  assert.equal(local.with.context, 'ServerDesk'); assert.equal(local.with.target, 'runtime'); assert.equal(local.with.platforms, 'linux/amd64');
  const smoke = index(step => /node scripts\/pipeline\.mjs smoke --image /.test(step.run ?? ''));
  const versionCheck = index(step => /docker image inspect/.test(step.run ?? ''));
  const login = index(uses('docker/login-action'));
  const push = index(step => uses('docker/build-push-action')(step) && step.with.push === true);
  assert.ok(smoke > steps.indexOf(local) && smoke < login && login < push, 'build, smoke, then login and push');
  assert.ok(versionCheck > steps.indexOf(local) && versionCheck < login, 'the version check of the smoke image comes before login');
  assert.deepEqual(steps[versionCheck].env, { VERSION: '${{ steps.plan.outputs.version }}' });
  assert.match(steps[versionCheck].run, /grep -Fqx "SERVERDESK_VERSION=\$VERSION"/);
  assert.ok(index(uses('docker/setup-qemu-action')) < steps.indexOf(local) && index(uses('docker/setup-buildx-action')) < steps.indexOf(local));
  assert.deepEqual(steps[login].with, { registry: 'ghcr.io', username: '${{ github.actor }}', password: '${{ secrets.GITHUB_TOKEN }}' });
  assert.equal(steps[login].uses, 'docker/login-action@8aa5831fb8d48d8f76594c7ddde61ae58019f550');
  const published = steps[push].with;
  assert.equal(published.context, 'ServerDesk'); assert.equal(published.target, 'runtime');
  // linux/arm64 stays off until the image has an arm64 smoke test.
  assert.deepEqual(published.platforms.split(',').map(value => value.trim()).sort(), ['linux/amd64']);
  assert.equal(published.tags, '${{ steps.meta.outputs.tags }}');
  // The same build-arg in both builds, so the push reuses the smoke-tested layers.
  const buildArgs = value => value.trim().split('\n').map(line => line.trim());
  assert.deepEqual(buildArgs(local.with['build-args']), ['SERVERDESK_VERSION=${{ steps.plan.outputs.version }}']);
  assert.deepEqual(buildArgs(published['build-args']), buildArgs(local.with['build-args']));
  const meta = steps[index(uses('docker/metadata-action'))].with;
  assert.equal(meta.images, '${{ env.IMAGE }}');
  const tags = meta.tags.trim().split('\n').map(line => line.trim());
  const release = "enable=${{ steps.plan.outputs.release == 'true' }}";
  const edge = "enable=${{ steps.plan.outputs.channel == 'edge' }}";
  const dev = "enable=${{ steps.plan.outputs.channel == 'dev' }}";
  // A release gives the semver tags and latest, none on main edge and sha-, none on dev dev and dev-<sha7>.
  assert.deepEqual(tags, [
    `type=semver,pattern={{version}},value=\${{ steps.plan.outputs.version }},${release}`,
    `type=semver,pattern={{major}}.{{minor}},value=\${{ steps.plan.outputs.version }},${release}`,
    `type=raw,value=latest,${release}`,
    `type=raw,value=edge,${edge}`,
    `type=sha,prefix=sha-,format=short,${edge}`,
    `type=raw,value=dev,${dev}`,
    `type=raw,value=\${{ steps.plan.outputs.version }},${dev}`,
  ]);
  assert.ok(!meta.tags.includes("release != 'true'"), 'edge and dev tags depend on the channel, not on release');
  assert.match(meta.flavor, /latest=false/);
  assert.equal(meta.labels.trim(), 'org.opencontainers.image.version=${{ steps.plan.outputs.version }}');
  // The release job: only after the push, only for a release, no action, only gh.
  const job = workflow.jobs.release;
  assert.equal(job.needs, 'publish');
  assert.equal(job.if, "needs.publish.outputs.release == 'true'");
  assert.deepEqual(job.permissions, { contents: 'write' });
  assert.ok(job.steps.every(step => step.uses === undefined && typeof step.run === 'string'), 'no uses: in the release job');
  assert.equal(job.env.GH_TOKEN, '${{ github.token }}');
  assert.equal(job.env.SHA, '${{ github.sha }}');
  for (const [name, output] of [['TAG', 'tag'], ['PREVIOUS_TAG', 'previous_tag'], ['NOTES', 'notes']]) assert.equal(job.env[name], `\${{ needs.publish.outputs.${output} }}`);
  const [createTag, createRelease] = job.steps.map(step => step.run);
  assert.match(createTag, /gh api --method POST "repos\/\$GH_REPO\/git\/refs" -f "ref=refs\/tags\/\$TAG" -f "sha=\$SHA"/);
  assert.match(createTag, /gh api "repos\/\$GH_REPO\/git\/ref\/tags\/\$TAG"/);
  assert.match(createTag, /if \[ "\$existing" != "\$SHA" \]; then[\s\S]*exit 1/);
  assert.match(createRelease, /set -- --verify-tag --title "\$TAG" --generate-notes --notes "\$NOTES"/);
  assert.match(createRelease, /if \[ -n "\$PREVIOUS_TAG" \]; then\s+set -- "\$@" --notes-start-tag "\$PREVIOUS_TAG"/);
  assert.match(createRelease, /gh release create "\$TAG" "\$@"/);
  // Values reach run: scripts only through env:.
  for (const step of allSteps) {
    assert.ok(!(step.run ?? '').includes('secrets.'), `no secret in run: ${step.name}`);
    assert.doesNotMatch(step.run ?? '', /\$\{\{[^}]*\b(?:secrets|steps|needs|inputs|github\.event)\./, `no inline expression in run: ${step.name}`);
  }
  // No expression at all in the run: scripts of the publish job: the plan and the registry check get every value through env:.
  for (const step of steps) assert.ok(!(step.run ?? '').includes('${{'), `no expression in run: ${step.name}`);
});

test('the image workflow header names the GHCR image, the GITHUB_TOKEN and the public visibility, and no environment', async () => {
  const text = (await readFile(path.join(repository, '.github', 'workflows', 'docker-image.yml'), 'utf8')).replaceAll('\r\n', '\n');
  const header = text.slice(0, text.indexOf('\nname:')).split('\n').map(line => line.replace(/^#\s?/, '')).join(' ');
  assert.match(header, /ghcr\.io\/nodiverna\/nodiverna/);
  assert.match(header, /GITHUB_TOKEN \(packages: write\)/);
  assert.match(header, /needs no secret and no environment/);
  assert.match(header, /After the first push, an organisation owner sets the package visibility to public/);
  assert.match(header, /on dev it pushes dev and dev-<sha7>/);
  assert.match(header, /Releases \(patch and minor\) run only from main/);
  assert.doesNotMatch(header, /DOCKERHUB|docker-hub|Docker Hub/);
  const workflow = yaml.load(text);
  assert.match(workflow.on.workflow_dispatch.inputs.release.description, /from main.*, or dev and dev- from dev\.$/);
  // The comment above the publish permissions names the branch rule of planRelease, not an environment.
  const lines = text.split('\n');
  const publish = lines.indexOf('  publish:');
  const jobComment = lines.slice(publish + 1, lines.indexOf('    permissions:', publish)).join(' ');
  assert.match(jobComment, /main \(releases, or edge and sha-\) and dev \(dev and dev-\)/);
  assert.doesNotMatch(jobComment, /environment/);
});

test('actionlint accepts the CI, image, agent and plugin release workflows', t => {
  const result = spawnSync('actionlint', ['.github/workflows/ci.yml', '.github/workflows/docker-image.yml', '.github/workflows/agent-release.yml', '.github/workflows/plugin-release.yml'], { cwd: repository, encoding: 'utf8' });
  if (result.error?.code === 'ENOENT') { t.skip('actionlint not installed'); return; }
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}${result.error ?? ''}`);
});

test('the private NAS tooling and the internal reviews are gone from ServerDesk', () => {
  // Built from parts so this file does not contain the strings it scans for.
  for (const name of [['deploy', 'nas.sh'], ['deploy', 'nas.env.example'], ['compose.nas' + '.dev.yaml'], ['tests', 'selfhost-nas-dev.mjs'],
    ['docs', 'project-review-2026-10-14.md'], ['docs', 'solution-review-2026-10-19.md'], ['docs', 'security-audit-2026-10-10.md'],
    ['docs', 'releasing.md'], ['docs', 'e2e.md'], ['docs', 'console-redesign.md'], ['docs', 'content-security-policy.md'],
    ['docs', 'v3-release-uploads.md'], ['docs', 'v3-protocol.md']]) {
    assert.ok(!existsSync(path.join(root, ...name)), `${name.join('/')} is removed`);
  }
  // The removed test stays removed in every folder below tests/: the check goes by base name.
  const testBaseNames = readdirSync(path.join(root, 'tests'), { recursive: true }).map(file => path.basename(String(file)));
  assert.ok(testBaseNames.length > 350 && !testBaseNames.includes('selfhost-nas-dev.mjs'), 'selfhost-nas-dev.mjs is in no folder below tests/');
});

test('pipeline.mjs has no NAS operation and rejects --reuse-dev-image without calling Docker', async () => {
  // An empty PATH: a Docker call would fail with ENOENT instead of the expected message.
  const emptyPath = await mkdtemp(path.join(os.tmpdir(), 'serverdesk-no-docker-'));
  try {
    const cli = args => spawnSync(process.execPath, [path.join(root, 'scripts', 'pipeline.mjs'), ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: emptyPath, Path: emptyPath } });
    const removed = cli(['nas', '--target', 'a@b', '--path', '/x']);
    assert.equal(removed.status, 1);
    assert.match(removed.stderr, /^Usage: node scripts\/pipeline\.mjs /);
    assert.doesNotMatch(removed.stderr, /\bnas\b|reuse-dev-image/);
    const reuse = cli(['up', '--reuse-dev-image']);
    assert.equal(reuse.status, 1);
    assert.match(reuse.stderr, /Unexpected arguments: --reuse-dev-image/);
  } finally { await rm(emptyPath, { recursive: true, force: true }); }
  const source = await readFile(path.join(root, 'scripts', 'pipeline.mjs'), 'utf8');
  assert.doesNotMatch(source, /savedNasDev|compose\.nas|reuse-dev-image|case 'nas'/);
});

// Execute the real CLI with process/filesystem/command boundaries replaced.
// It cannot read local secrets or change a real deployment.
const pipelineSource = await readFile(path.join(root, 'scripts', 'pipeline.mjs'), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const executePipeline = new AsyncFunction('injected', `
  const { spawn, rename, writeFile, existsSync, path, fileURLToPath, process, console } = injected;
  ${pipelineSource.replace(/^import .*;\r?$/gm, '').replaceAll('import.meta.url', 'injected.moduleUrl')}
`);
async function pipeline(args, { state, failUp = false, environment = {} } = {}) {
  const calls = [], events = [], writes = [], errors = [];
  const fakeProcess = { argv: ['node', 'pipeline.mjs', ...args], env: environment, platform: process.platform, execPath: process.execPath, pid: 1234, exitCode: 0 };
  const statePath = path.join(root, '.env.deployment');
  const files = new Map(state === undefined ? [] : [[statePath, state]]);
  const boundary = {
    moduleUrl: new URL('../../scripts/pipeline.mjs', import.meta.url).href,
    process: fakeProcess, path, fileURLToPath,
    existsSync: filename => files.has(filename),
    writeFile: async (filename, contents, options) => { writes.push({ filename, contents, options }); events.push(['write', filename]); files.set(filename, contents); },
    rename: async (from, to) => { events.push(['rename', from, to]); files.set(to, files.get(from)); files.delete(from); },
    console: { log() {}, error(message) { errors.push(message); } },
    spawn(command, commandArgs, options) {
      calls.push({ command, args: commandArgs, options });
      events.push(['spawn', command, commandArgs]);
      const child = new EventEmitter(); child.stdout = new EventEmitter();
      queueMicrotask(() => {
        if (command === 'docker' && commandArgs[0] === 'inspect') child.stdout.emit('data', 'healthy\n');
        if (command === 'docker' && commandArgs[0] === 'exec' && commandArgs.includes('pg_isready')) child.stdout.emit('data', 'accepting connections\n');
        if (command === 'docker' && commandArgs.includes('backup')) child.stdout.emit('data', JSON.stringify({ file: '/data/backups/smoke.dump', sha256: 'a'.repeat(64), bytes: 1 }));
        if (command === 'docker' && commandArgs.includes('restore')) child.stdout.emit('data', '{"applied":["0000_baseline.sql"],"pending":[]}');
        if (command === 'docker' && commandArgs[0] === 'exec' && commandArgs.includes('migrate')) child.stdout.emit('data', '{"applied":0,"total":1}');
        const failed = failUp && command === 'docker' && commandArgs[0] === 'compose' && commandArgs.includes('up');
        events.push(['complete', command, failed ? 1 : 0]); child.emit('close', failed ? 1 : 0);
      });
      return child;
    },
  };
  let fatal;
  try { await executePipeline(boundary); } catch (error) { fatal = error; }
  return { calls, events, writes, errors, fatal, exitCode: fakeProcess.exitCode, state: files.get(statePath) };
}
const composeFiles = call => call.args.flatMap((argument, index) => argument === '-f' ? [call.args[index + 1]] : []);
const envFiles = call => call.args.filter((argument, index) => call.args[index - 1] === '--env-file');
const volumeMounts = args => args.flatMap((value, index) => value === '-v' ? [args[index + 1]] : []);

test('up --image commits the tested image only after a healthy start; administration uses compose.yaml', async () => {
  const started = await pipeline(['up', '--image', 'serverdesk:local']);
  assert.equal(started.fatal, undefined); assert.equal(started.exitCode, 0);
  assert.deepEqual(composeFiles(started.calls[0]), ['compose.yaml']);
  assert.deepEqual(envFiles(started.calls[0]), ['.env.runtime']);
  assert.equal(started.calls[0].options.env.SERVERDESK_IMAGE, 'serverdesk:local');
  assert.equal(started.calls[0].args.at(-1), '120');
  assert.equal(started.state, 'SERVERDESK_IMAGE=serverdesk:local\nSERVERDESK_DEPLOYMENT_MODE=production\nCOMPOSE_FILE=compose.yaml\n');
  assert.equal(started.writes[0].options.mode, 0o600);
  assert.ok(started.events.findIndex(event => event[0] === 'write') > started.events.findIndex(event => event[0] === 'complete'));
  assert.equal(started.events.at(-1)[0], 'rename', 'deployment state is committed atomically');
  const failed = await pipeline(['up', '--image', 'serverdesk:local'], { failUp: true });
  assert.equal(failed.exitCode, 1); assert.equal(failed.writes.length, 0); assert.equal(failed.state, undefined);
  // A state file left by the former NAS development mode no longer adds an overlay.
  const legacy = 'SERVERDESK_IMAGE=serverdesk:nas-development\nSERVERDESK_DEPLOYMENT_MODE=development\nCOMPOSE_FILE=compose.yaml:compose.nas' + '.dev.yaml\n';
  for (const args of [['up'], ['down'], ['migrate'], ['bootstrap-owner', '--username', 'admin']]) {
    const result = await pipeline(args, { state: legacy });
    assert.equal(result.exitCode, 0); assert.equal(result.calls.length, 1);
    assert.deepEqual(composeFiles(result.calls[0]), ['compose.yaml']);
    assert.deepEqual(envFiles(result.calls[0]), ['.env.runtime', '.env.deployment']);
    assert.ok(!result.calls[0].args.includes('-v') && !result.calls[0].args.includes('--volumes'), 'administration never removes persistent volumes');
    assert.equal(result.writes.length, 0); assert.equal(result.state, legacy);
  }
  const migrated = await pipeline(['up', '--migrate']);
  assert.deepEqual(migrated.calls.map(call => call.args.find(value => ['stop', 'run', 'up'].includes(value))), ['stop', 'run', 'up']);
  assert.ok(!migrated.calls[1].args.includes('--no-deps'), 'run starts the database service first');
  const development = await pipeline(['up', '--dev', '--image', 'serverdesk:dev']);
  assert.deepEqual(composeFiles(development.calls[0]), ['compose.dev.yaml']); assert.equal(development.writes.length, 0);
  const conflicting = await pipeline(['up', '--dev', '--production']);
  assert.match(conflicting.fatal.message, /cannot be combined/); assert.equal(conflicting.calls.length, 0);
});

test('development smoke migrates the same persistent /data volume used by the validated startup', async () => {
  const result = await pipeline(['smoke', '--dev', '--image', 'serverdesk:dev']);
  assert.equal(result.fatal?.message, undefined); assert.equal(result.exitCode, 0, String(result.errors));
  const runs = result.calls.filter(call => call.command === 'docker' && call.args[0] === 'run' && call.args.includes('serverdesk:dev'));
  assert.equal(runs.length, 4, 'migrate, backup, restore and the app run on the app image; no selfhost maintenance run');
  for (const call of runs) {
    for (const setting of ['OBJECT_STORAGE_DRIVER=filesystem', 'OBJECT_STORAGE_PATH=/data/objects', 'NODE_ENV=development', 'DATABASE_PASSWORD']) assert.ok(call.args.includes(setting), setting);
    assert.ok(call.args.some(value => /^DATABASE_URL=postgres:\/\/serverdesk@(db:5432\/serverdesk|serverdesk-smoke-[\w-]+-restore:5432\/serverdesk\?sslmode=disable)$/.test(value)), 'a PostgreSQL URL without a password');
    assert.ok(volumeMounts(call.args).includes(`${root}:/app`));
    assert.ok(volumeMounts(call.args).some(mount => mount.endsWith(':/app/node_modules')));
    assert.ok(volumeMounts(call.args).some(mount => mount.endsWith(':/app/.next')));
  }
  // The app and the CLI reach the smoke database as the local host db (no TLS,
  // accepted by the startup check); only the restore target is named, with an
  // explicit sslmode=disable for the CLI.
  const urls = runs.map(call => call.args.find(value => value.startsWith('DATABASE_URL=')));
  assert.deepEqual(urls.filter((url, index) => index !== 2), Array(3).fill('DATABASE_URL=postgres://serverdesk@db:5432/serverdesk'));
  assert.match(urls[2], /-restore:5432\/serverdesk\?sslmode=disable$/);
  const primary = result.calls.find(call => call.args[0] === 'run' && call.args.includes('postgres:17-alpine'));
  assert.equal(primary.args[primary.args.indexOf('--network-alias') + 1], 'db');
  for (const call of runs.slice(1)) assert.equal(call.args[call.args.indexOf('-v') + 1], runs[0].args[runs[0].args.indexOf('-v') + 1]);
  assert.deepEqual(runs[0].args.slice(-3), ['node', 'scripts/selfhost.mjs', 'migrate']);
  // No selfhost maintenance run: the scheduler in the app container writes the row.
  assert.ok(!runs.some(call => call.args.includes('maintenance')), 'the smoke plan has no selfhost maintenance run');
  assert.deepEqual(runs[3].args.slice(0, 2), ['run', '-d']);
  // After the health check, it waits up to 120 s for exactly one succeeded schedule row.
  const recorded = result.calls.find(call => call.args[0] === 'exec' && call.args.at(-1).includes('maintenance_runs'));
  assert.ok(recorded, 'the smoke checks maintenance_runs in the container');
  assert.ok(recorded.args.at(-1).includes("rows.length!==1||rows[0].status!=='succeeded'||rows[0].trigger!=='schedule'"));
  assert.ok(recorded.args.at(-1).includes('second<120'), 'it waits up to 120 seconds');
  const inspected = result.calls.findIndex(call => call.args[0] === 'inspect'), restarted = result.calls.findIndex(call => call.args[0] === 'restart');
  assert.ok(inspected < result.calls.indexOf(recorded) && result.calls.indexOf(recorded) < restarted);
  assert.deepEqual(runs[3].args.slice(-10), ['node', '--import', './runtime/startup.mjs', 'node_modules/next/dist/bin/next', 'dev', '--webpack', '--hostname', '0.0.0.0', '--port', '3000']);
  const created = result.calls.filter(call => call.args[0] === 'volume' && call.args[1] === 'create').map(call => call.args[2]);
  assert.equal(created.length, 5, 'app data, two database volumes and the two dev caches');
  assert.deepEqual(result.calls.filter(call => call.args[0] === 'volume' && call.args[1] === 'rm').map(call => call.args[2]).sort(), [...created].sort());
  assert.ok(runs[3].args.includes('--health-cmd'));
  assert.ok(result.calls.some(call => call.args[0] === 'restart'));
  assert.deepEqual(result.calls.at(-1).args.slice(0, 2), ['network', 'rm'], 'only isolated smoke data and its network are removed');
});

// The strings are assembled so that this file does not match itself. The second
// line holds real environment and personal names that test and demo data replaced
// with documentation values (lab.example, CT-WS01, Contoso Devices).
const forbidden = [['192', '168', '178', '5'].join('.'), 'nifi' + '@', '/home/' + 'nifi', 'appgprj' + '_', 'deploy/' + 'nas.sh', 'compose.nas' + '.dev', 'pipeline.mjs' + ' nas',
  'nf' + 'i.local', 'NF' + 'I-WS', 'NF' + 'I-DC', 'Eizi' + 'kovich'];
const forbiddenFindings = (name, text) => forbidden.filter(value => text.includes(value)).map(value => `${name}: ${value}`);
const skippedPrefixes = ['factory' + '/', '.claude/', 'ServerDesk/public/downloads/'];
function isBinary(file) {
  const handle = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(8000);
    return buffer.subarray(0, readSync(handle, buffer, 0, buffer.length, 0)).includes(0);
  } finally { closeSync(handle); }
}

test('the forbidden list finds each real environment and personal name in a text', () => {
  for (const value of ['nf' + 'i.local', 'NF' + 'I-WS01', 'NF' + 'I-DC01', 'Shaul ' + 'Eizi' + 'kovich']) {
    assert.equal(forbiddenFindings('sample.cs', `const host = "${value}";`).length, 1, value);
  }
  assert.deepEqual(forbiddenFindings('sample.cs', 'lab.example CT-WS01 Contoso Devices 192.0.2.2'), []);
});

test('no tracked text file outside the factory and .claude folders contains a private NAS address, user, path, hosting ID, real environment name or personal name', async t => {
  const listed = spawnSync('git', ['ls-files', '-z'], { cwd: repository, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (listed.status !== 0) { t.skip('git ls-files is not available'); return; }
  const files = listed.stdout.split('\0').filter(name => name && !skippedPrefixes.some(prefix => name.startsWith(prefix)));
  assert.ok(files.includes('ServerDesk/compose.yaml'));
  const findings = [];
  for (const name of files) {
    const file = path.join(repository, name);
    if (!existsSync(file) || isBinary(file)) continue;
    const text = await readFile(file, 'utf8');
    findings.push(...forbiddenFindings(name, text));
  }
  assert.deepEqual(findings, []);
});


// The database service: PostgreSQL 17 in its own container with its own volume,
// a TCP healthcheck, no published port and the password only by name.
test('compose.yaml and compose.dev.yaml run PostgreSQL 17 as the db service; the Dockerfile ships pg_dump 17', async () => {
  const development = yaml.load(await readFile(path.join(root, 'compose.dev.yaml'), 'utf8'));
  for (const [file, definition, volume] of [['compose.yaml', compose, 'db-data'], ['compose.dev.yaml', development, 'dev-db-data']]) {
    const { db } = definition.services;
    assert.ok(db, `${file} has a db service`);
    assert.match(db.image, /^postgres:17(\.\d+)?-alpine$/, `${file}: a fixed major version`);
    assert.deepEqual([db.environment.POSTGRES_USER, db.environment.POSTGRES_DB], ['serverdesk', 'serverdesk'], file);
    assert.match(db.environment.POSTGRES_PASSWORD, /^\$\{DATABASE_PASSWORD(:\?[^}]*)?\}$/, `${file}: the password only by name`);
    assert.deepEqual(db.volumes, [`${volume}:/var/lib/postgresql/data`], file);
    assert.ok(Object.hasOwn(definition.volumes, volume), `${file} declares ${volume}`);
    assert.ok(db.healthcheck.test.includes('pg_isready') && db.healthcheck.test.includes('serverdesk'), `${file}: pg_isready healthcheck`);
    assert.equal(db.ports, undefined, `${file}: no published database port`);
    assert.deepEqual(db.security_opt, ['no-new-privileges:true'], file);
    assert.deepEqual(definition.services.app.depends_on?.db, { condition: 'service_healthy' }, `${file}: the app waits for a healthy db`);
  }
  assert.equal(compose.services.db.restart, 'unless-stopped');
  for (const file of ['compose.yaml', 'compose.dev.yaml', 'Dockerfile', 'scripts/pipeline.mjs']) {
    const text = await readFile(path.join(root, file), 'utf8');
    assert.doesNotMatch(text, /--no-deps/, `${file} has no --no-deps`);
    if (file !== 'scripts/pipeline.mjs') assert.doesNotMatch(text, /POSTGRES_PASSWORD[:=]\s*['"]?[^$\s'"]/, `${file} holds no password value`);
  }
  const dockerfile = await readFile(path.join(root, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /apt-get install -y --no-install-recommends postgresql-client-17\b/, 'the PGDG client tools of version 17');
  assert.doesNotMatch(dockerfile, /DATABASE_URL=file:/);
  const stages = [...dockerfile.matchAll(/^FROM (\S+) AS (\S+)$/gm)].map(match => [match[2], match[1]]);
  const parent = Object.fromEntries(stages);
  const ancestry = stage => (parent[stage] && parent[stage] !== stage && stages.some(([name]) => name === parent[stage]) ? [stage, ...ancestry(parent[stage])] : [stage]);
  const installer = stages.find(([, from]) => from.startsWith('node:'))?.[0];
  assert.ok(installer && /postgresql-client-17/.test(dockerfile.split(/^FROM /m).find(part => part.includes(`AS ${installer}`))), 'the client tools are installed in the base stage');
  for (const stage of ['runtime', 'development']) assert.ok(ancestry(stage).includes(installer), `${stage} builds on the stage with pg_dump 17`);
  assert.match(dockerfile, /mkdir -p \/data\/objects \/data\/backups && chown -R node:node \/data/, '/data holds objects and backups and belongs to node');
});

// db is only on the internal network "database"; only the services that run the
// app image join it. The proxy stays on default, where it reaches app:3000.
test('compose.yaml and compose.dev.yaml put db on the internal network database, which only the app-image services join', async () => {
  const development = yaml.load(await readFile(path.join(root, 'compose.dev.yaml'), 'utf8'));
  for (const [file, definition, appImageServices] of [['compose.yaml', compose, ['app']], ['compose.dev.yaml', development, ['app']]]) {
    assert.deepEqual(definition.networks?.database, { internal: true }, `${file}: the top-level network database is internal`);
    assert.deepEqual(Object.keys(definition.networks), ['database'], `${file}: no other network is declared`);
    const { db, proxy } = definition.services;
    assert.deepEqual(networkNames(db), ['database'], `${file}: db is only on database`);
    for (const name of appImageServices) assert.deepEqual(networkNames(definition.services[name]), ['database', 'default'], `${file}: ${name} is on default and database`);
    assert.ok(!networkNames(proxy).includes('database'), `${file}: the proxy is not on database`);
    for (const [name, service] of Object.entries(definition.services)) {
      if (!['db', ...appImageServices].includes(name)) assert.ok(!networkNames(service).includes('database'), `${file}: ${name} is not on database`);
    }
    // The app reaches the database by the service name on the shared network.
    assert.match(definition.services.app.environment.DATABASE_URL, /@db:5432\//, file);
  }
  assert.match(composeText.split('\nservices:')[0], /internal network "database"/, 'the header comment names the internal network');
});

// The PGDG apt key is trusted only with its pinned fingerprint, and apt gets a
// keyring with only that key. The check tools are gone after the same RUN.
test('the Dockerfile trusts the PGDG apt key only with the pinned fingerprint', async () => {
  const fingerprint = 'B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8';
  const dockerfile = (await readFile(path.join(root, 'Dockerfile'), 'utf8')).replaceAll('\r\n', '\n');
  const stagesText = dockerfile.split(/^FROM /m);
  const base = stagesText.find(part => /^\S+ AS base\n/.test(part));
  assert.ok(base, 'the Dockerfile has a base stage');
  const instructions = base.replace(/\\\n/g, ' ').split('\n');
  const pinned = new RegExp(fingerprint.match(/.{4}/g).join(' ?'), 'i');
  const run = instructions.find(line => line.startsWith('RUN ') && pinned.test(line));
  assert.ok(run, 'the fingerprint is a literal in a RUN instruction of the base stage');
  assert.ok(!dockerfile.split('\n').some(line => /^\s*ARG\b/.test(line) && pinned.test(line)), 'no build ARG holds the fingerprint');
  assert.ok(!/^\s*ARG\b.*fingerprint/im.test(dockerfile), 'no build ARG can replace the fingerprint');
  const variable = new RegExp(`(\\w+)=${fingerprint}`, 'i').exec(run)?.[1];
  assert.ok(variable, 'the RUN keeps the fingerprint in a shell variable');
  const at = pattern => { const match = pattern.exec(run); assert.ok(match, `the RUN contains ${pattern}`); return match.index; };
  const download = at(/curl -fsSL -o "([^"]+)" https:\/\/www\.postgresql\.org\/media\/keys\/ACCC4CF8\.asc/);
  const downloaded = /curl -fsSL -o "([^"]+)"/.exec(run)[1];
  const imported = at(/gpg --batch(?: --quiet)? --import /);
  const exported = at(new RegExp(`gpg --batch --export "\\$${variable}" > "([^"]+)"`));
  const check = at(new RegExp(`if \\[ "\\$\\w+" != "\\$${variable}" \\]; then [^;]*; exit 1; fi`));
  const keyring = /signed-by=([^\]\s]+)/.exec(run)?.[1];
  assert.ok(keyring, 'pgdg.list names a keyring with signed-by=');
  assert.notEqual(keyring, downloaded, 'apt does not trust the raw downloaded key file');
  assert.doesNotMatch(keyring, /\.asc$/, 'the keyring is the binary export, not an .asc file');
  const installed = at(new RegExp(`install -m 644 "[^"]+" ${keyring.replaceAll('/', '\\/').replaceAll('.', '\\.')}`));
  const source = at(/> \/etc\/apt\/sources\.list\.d\/pgdg\.list/);
  const client = at(/apt-get install -y --no-install-recommends postgresql-client-17\b/);
  assert.ok(download < imported && imported < exported && exported < check && check < installed && installed < source && source < client, 'download, import, export, check, keyring, source and install run in this order');
  assert.ok(run.lastIndexOf('apt-get update', client) > source, 'apt-get update runs again with the PGDG source');
  assert.match(run, /^RUN set -eu;/, 'every failing command stops the RUN');
  // The check tools are installed and purged in the same RUN; GnuPG leaves no home and no agent.
  const tools = /apt-get install -y --no-install-recommends ([^;&]+)/.exec(run)[1].trim().split(/\s+/).filter(name => name !== 'ca-certificates');
  assert.ok(tools.includes('curl') && tools.some(name => name === 'gpg' || name === 'gnupg'), 'curl and GnuPG are installed for the check');
  const purged = /apt-get purge -y ([^;&]+)/.exec(run)?.[1].trim().split(/\s+/) ?? [];
  assert.deepEqual(purged.slice().sort(), tools.slice().sort(), 'every tool installed for the check is purged');
  assert.ok(at(/apt-get purge -y /) > client && at(/apt-get autoremove -y/) > client, 'the purge runs after the client install');
  assert.match(run, /gpgconf --kill all;/, 'the GnuPG agent is stopped');
  assert.match(run, /rm -rf "\$GNUPGHOME";/, 'the temporary GnuPG home is deleted');
  assert.match(run, /GNUPGHOME="\$\(mktemp -d\)"; export GNUPGHOME;/, 'GnuPG uses a temporary home');
  assert.ok(downloaded.startsWith('$GNUPGHOME/'), 'the download goes into the temporary GnuPG home');
  for (const part of stagesText.filter(text => !/^\S+ AS base\n/.test(text))) assert.doesNotMatch(part, /\bgpg\b|gnupg/, 'no other stage installs GnuPG');
});

// The runtime image runs runtime/*.mjs and scripts/selfhost.mjs outside the Next
// bundle (migrate, backup, restore, bootstrap-owner, the startup check). Their
// packages reach .next/standalone/node_modules only as serverExternalPackages.
test('every package the runtime scripts import ships in the standalone output', async () => {
  const config = await readFile(path.join(root, 'next.config.ts'), 'utf8');
  const externals = JSON.parse(/serverExternalPackages:\s*(\[[^\]]*\])/.exec(config)?.[1] ?? '[]');
  const runtimeFiles = (await readdir(path.join(root, 'runtime'))).filter(name => name.endsWith('.mjs')).map(name => path.join('runtime', name));
  const imported = new Set();
  for (const file of [...runtimeFiles, path.join('scripts', 'selfhost.mjs')]) {
    const text = await readFile(path.join(root, file), 'utf8');
    for (const [, specifier] of text.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*)['"]([^'"]+)['"]/g)) {
      if (specifier.startsWith('.') || specifier.startsWith('node:')) continue;
      imported.add(specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]);
    }
  }
  assert.ok(imported.has('postgres'), 'runtime/database.mjs imports postgres');
  for (const name of imported) assert.ok(externals.includes(name), `${name} is imported by the runtime scripts and must be in serverExternalPackages`);
  // Assembled, so that the legacy-cleanup scan does not match this file.
  assert.ok(!externals.includes(['@lib', 'sql/client'].join('')), 'the old database client is gone');
  const dockerfile = await readFile(path.join(root, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /COPY --from=build --chown=node:node \/app\/\.next\/standalone \.\//);
  assert.match(dockerfile, /chmod 700 \/data\/backups/, 'the backup directory in the image is owner-only');
});
