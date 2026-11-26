// The CI workflow (.github/workflows/ci.yml): its triggers with the daily
// schedule, read-only permissions, no secrets and no database credentials, the
// jobs "Typecheck, lint and tests", "Dependency audit" and "HTTP integration"
// with their time limits and steps, the pnpm version of packageManager; the
// SHA pins of every workflow, CODEOWNERS, .github/dependabot.yml, and the
// removed Azure pipeline file.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { repositoryRoot, serverDeskRoot } from '../support/paths.mjs';

const require = createRequire(import.meta.url);
// js-yaml is an existing ESLint dependency, not a new application dependency.
const yaml = createRequire(require.resolve('eslint/package.json'))('js-yaml');
const workflowsFolder = path.join(repositoryRoot, '.github', 'workflows');
const workflowText = (await readFile(path.join(workflowsFolder, 'ci.yml'), 'utf8')).replaceAll('\r\n', '\n');
const workflow = yaml.load(workflowText);
const jobs = workflow.jobs ?? {};
const packageJson = JSON.parse(await readFile(path.join(serverDeskRoot, 'package.json'), 'utf8'));
const packageManager = packageJson.packageManager;
const header = workflowText.slice(0, workflowText.indexOf('\nname:')).split('\n').map(line => line.replace(/^#\s?/, '')).join(' ');
const notSchedule = "github.event_name != 'schedule'";
// The index of the first step in ServerDesk whose run: has this command as one of its lines.
const stepIndex = (job, command) => job.steps.findIndex(step => step['working-directory'] === 'ServerDesk' && (step.run ?? '').split('\n').map(line => line.trim()).includes(command));
const corepackIndex = job => job.steps.findIndex(step => /corepack prepare pnpm@/.test(step.run ?? ''));

test('the workflow CI runs on pushes to dev, pull requests into main and dev, once a day and by hand', () => {
  assert.equal(workflow.name, 'CI');
  assert.deepEqual(Object.keys(workflow.on).sort(), ['pull_request', 'push', 'schedule', 'workflow_dispatch']);
  assert.deepEqual(workflow.on.push, { branches: ['dev'] });
  assert.deepEqual(workflow.on.pull_request, { branches: ['main', 'dev'] });
  assert.ok(workflow.on.workflow_dispatch === null || typeof workflow.on.workflow_dispatch === 'object', 'workflow_dispatch has no inputs that run code');
  assert.equal(workflow.on.workflow_dispatch?.inputs, undefined);
  assert.ok(!('pull_request_target' in workflow.on), 'no pull_request_target');
  assert.doesNotMatch(workflowText, /pull_request_target/);
  // Exactly one daily cron with a fixed minute that is not 0: the top of the hour is the busiest time.
  assert.ok(Array.isArray(workflow.on.schedule) && workflow.on.schedule.length === 1, 'one schedule entry');
  const fields = workflow.on.schedule[0].cron.trim().split(/\s+/);
  assert.equal(fields.length, 5, workflow.on.schedule[0].cron);
  assert.match(fields[0], /^\d+$/, 'a fixed minute');
  assert.ok(Number(fields[0]) > 0 && Number(fields[0]) < 60, `minute ${fields[0]} is not 0`);
  assert.match(fields[1], /^\d+$/, 'a fixed hour');
  assert.ok(Number(fields[1]) < 24);
  assert.deepEqual(fields.slice(2), ['*', '*', '*'], 'every day');
});

test('the workflow has read-only permissions, no secrets, no environment and no database credentials', () => {
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.doesNotMatch(workflowText, /secrets\./, 'no secrets');
  assert.doesNotMatch(workflowText, /TEST_DATABASE_URL/, 'PostgreSQL comes from tests/support/postgres.mjs');
  assert.ok(!('environment' in workflow), 'no top-level environment');
  for (const [id, entry] of Object.entries(jobs)) {
    assert.ok(!('environment' in entry), `no environment in ${id}`);
    assert.ok(!('services' in entry), `no service container with a password in ${id}`);
    assert.ok(!('permissions' in entry), `no job permissions in ${id}`);
    for (const env of [workflow.env, entry.env, ...(entry.steps ?? []).map(step => step.env)]) {
      for (const name of Object.keys(env ?? {})) assert.doesNotMatch(name, /PASSWORD|DATABASE|POSTGRES/i, `no database credential in ${id}: ${name}`);
    }
  }
  assert.deepEqual(workflow.concurrency, { group: 'ci-${{ github.ref }}', 'cancel-in-progress': true }, 'one run per ref, a new push stops the old run');
});

test('the jobs are verify, audit and http-integration with their names, runners and time limits', () => {
  assert.deepEqual(Object.keys(jobs).sort(), ['audit', 'http-integration', 'verify']);
  const expected = {
    verify: { name: 'Typecheck, lint and tests', max: 90 },
    audit: { name: 'Dependency audit', max: 15 },
    'http-integration': { name: 'HTTP integration', max: 60 },
  };
  for (const [id, { name, max }] of Object.entries(expected)) {
    assert.equal(jobs[id].name, name, id);
    assert.equal(jobs[id]['runs-on'], 'ubuntu-latest', id);
    assert.equal(typeof jobs[id]['timeout-minutes'], 'number', id);
    assert.ok(jobs[id]['timeout-minutes'] > 0 && jobs[id]['timeout-minutes'] <= max, `${id}: timeout-minutes is at most ${max}: ${jobs[id]['timeout-minutes']}`);
  }
  // The scheduled run is only the audit of main: the heavy jobs skip it.
  assert.equal(jobs.verify.if, notSchedule);
  assert.equal(jobs['http-integration'].if, notSchedule);
  assert.equal(jobs.audit.if, undefined, 'the audit runs on every trigger, also on schedule');
  for (const job of Object.values(jobs)) assert.equal(job.needs, undefined, 'no job waits for another one');
});

test('the header explains the daily audit, the email, the free private plan and the names of the later required checks', () => {
  assert.match(header, /audits the default branch main once a day/);
  assert.match(header, /A failed run is the signal: GitHub sends an email/);
  assert.match(header, /the user who last changed the cron line/);
  assert.match(header, /private on the free plan/);
  assert.match(header, /cannot require these checks/);
  for (const name of ['Typecheck, lint and tests', 'Dependency audit', 'HTTP integration']) assert.ok(header.includes(`"${name}"`), name);
  assert.match(header, /ruleset/);
  assert.match(header, /no secrets/);
});

test('every job checks out without credentials and sets up Node 22 and the pnpm of packageManager', () => {
  assert.match(packageManager, /^pnpm@/);
  for (const [id, job] of Object.entries(jobs)) {
    assert.ok(job.steps[0].uses?.startsWith('actions/checkout@'), `${id}: checkout first`);
    assert.equal(job.steps[0].with?.['persist-credentials'], false, id);
    assert.ok(job.steps[1].uses?.startsWith('actions/setup-node@'), `${id}: setup-node second`);
    assert.equal(String(job.steps[1].with?.['node-version']), '22', id);
    assert.equal(corepackIndex(job), 2, `${id}: corepack selects pnpm third`);
    assert.match(job.steps[2].run, /corepack enable/);
  }
  const versions = [...workflowText.matchAll(/pnpm@([0-9][^\s'"]*)/g)].map(match => match[1]);
  assert.equal(versions.length, Object.keys(jobs).length, 'each job names the pnpm version');
  for (const version of versions) assert.equal(`pnpm@${version}`, packageManager, 'the pnpm version equals packageManager in ServerDesk/package.json');
});

test('the job audit runs pnpm check:audit in ServerDesk after corepack, with no install and no way to pass on an error', () => {
  const job = jobs.audit;
  const audit = stepIndex(job, 'pnpm check:audit');
  assert.ok(audit > corepackIndex(job), 'pnpm check:audit in ServerDesk after corepack');
  assert.equal(audit, job.steps.length - 1, 'the audit is the last step');
  assert.equal(job['continue-on-error'], undefined);
  for (const step of job.steps) {
    assert.equal(step['continue-on-error'], undefined, step.name);
    assert.doesNotMatch(step.run ?? '', /--ignore-registry-errors|pnpm install|pipeline\.mjs/, step.name);
  }
  // The script itself keeps the threshold and fails on registry errors.
  assert.equal(packageJson.scripts['check:audit'], 'pnpm audit --audit-level high');
});

test('the job verify installs with pipeline.mjs and then runs pnpm validate in ServerDesk', () => {
  const job = jobs.verify;
  const install = stepIndex(job, 'node scripts/pipeline.mjs install'), validate = stepIndex(job, 'pnpm validate');
  assert.ok(install > corepackIndex(job), 'the install runs after corepack');
  assert.ok(install < validate, 'the install runs before pnpm validate');
  assert.equal(job.steps.length, 5);
  const env = job.steps[validate].env ?? {};
  for (const name of Object.keys(env)) assert.ok(['TEST_CONCURRENCY', 'NEXT_TELEMETRY_DISABLED'].includes(name), name);
  if ('TEST_CONCURRENCY' in env) assert.match(String(env.TEST_CONCURRENCY), /^[1-9]\d*$/);
});

test('the job http-integration installs with pipeline.mjs and then runs pnpm test:http, the only run of it', () => {
  const job = jobs['http-integration'];
  const install = stepIndex(job, 'node scripts/pipeline.mjs install'), http = stepIndex(job, 'pnpm test:http');
  assert.ok(install > corepackIndex(job), 'the install runs after corepack');
  assert.ok(install < http, 'the install runs before the test');
  assert.deepEqual(job.steps.map(step => step.name), ['Check out', 'Set up Node.js', 'Select pinned pnpm', 'Install the dependencies', 'Run the HTTP integration test']);
  const runs = Object.values(jobs).flatMap(entry => entry.steps).map(step => step.run ?? '');
  assert.equal(runs.filter(run => /pnpm test:http/.test(run)).length, 1, 'pnpm test:http runs once');
  assert.ok(!runs.some(run => /pipeline\.mjs verify/.test(run)), 'no pipeline.mjs verify: it would run test:http again');
});

test('every action in every workflow is pinned to a commit SHA with a version comment', async () => {
  const files = (await readdir(workflowsFolder)).filter(name => /\.ya?ml$/.test(name));
  assert.ok(files.includes('ci.yml') && files.includes('docker-image.yml') && files.length >= 4, files.join(', '));
  for (const file of files) {
    const text = (await readFile(path.join(workflowsFolder, file), 'utf8')).replaceAll('\r\n', '\n');
    const lines = text.split('\n').filter(line => /^\s*(?:-\s+)?uses:/.test(line));
    assert.ok(lines.length > 0, `${file} uses actions`);
    for (const line of lines) assert.match(line, /@[0-9a-f]{40} # v\d+\.\d+\.\d+$/, `${file}: ${line}`);
    const parsed = yaml.load(text);
    const values = Object.values(parsed.jobs).flatMap(job => job.steps ?? []).filter(step => step.uses).map(step => step.uses);
    assert.equal(values.length, lines.length, `${file}: every uses: line is a step`);
    for (const value of values) assert.match(value, /^[a-z0-9-]+\/[a-z0-9-]+@[0-9a-f]{40}$/, `${file}: ${value}`);
  }
});

test('CODEOWNERS names the owner for every file', async () => {
  const lines = (await readFile(path.join(repositoryRoot, '.github', 'CODEOWNERS'), 'utf8')).split(/\r?\n/).map(line => line.trim());
  assert.deepEqual(lines.filter(line => line && !line.startsWith('#')), ['* @LostInDreamZ']);
});

test('Dependabot sends small grouped version updates to dev only', async () => {
  const text = (await readFile(path.join(repositoryRoot, '.github', 'dependabot.yml'), 'utf8')).replaceAll('\r\n', '\n');
  const config = yaml.load(text);
  assert.equal(config.version, 2);
  assert.equal(config.updates.length, 2);
  const [npm, actions] = config.updates;
  assert.deepEqual([npm['package-ecosystem'], npm.directory], ['npm', '/ServerDesk']);
  assert.deepEqual([actions['package-ecosystem'], actions.directory], ['github-actions', '/']);
  for (const entry of config.updates) {
    assert.equal(entry['target-branch'], 'dev', `${entry['package-ecosystem']} targets dev, never main`);
    assert.equal(entry.schedule?.interval, 'weekly', entry['package-ecosystem']);
    for (const group of Object.values(entry.groups ?? {})) assert.equal(group['applies-to'], undefined, 'security update PRs are off, so no group for them');
  }
  assert.ok(npm['open-pull-requests-limit'] >= 1 && npm['open-pull-requests-limit'] <= 3, 'npm: at most 3 open PRs');
  assert.ok(actions['open-pull-requests-limit'] >= 1 && actions['open-pull-requests-limit'] <= 2, 'actions: at most 2 open PRs');
  // The same 7 days as minimumReleaseAge in pnpm-workspace.yaml.
  assert.equal(npm.cooldown?.['default-days'], 7);
  const workspace = yaml.load(await readFile(path.join(serverDeskRoot, 'pnpm-workspace.yaml'), 'utf8'));
  assert.equal(workspace.minimumReleaseAge, npm.cooldown['default-days'] * 24 * 60);
  // The security-relevant runtime group comes first.
  assert.deepEqual(Object.keys(npm.groups), ['runtime', 'tooling']);
  assert.deepEqual(npm.groups.runtime, { 'dependency-type': 'production', 'update-types': ['minor', 'patch'] });
  assert.deepEqual(npm.groups.tooling, { 'dependency-type': 'development', 'update-types': ['minor', 'patch'] });
  assert.deepEqual(actions.groups, { actions: { patterns: ['*'] } });
  // The comment at the top gives the reason for target-branch: dev.
  const comment = text.slice(0, text.indexOf('\nversion:')).split('\n').map(line => line.replace(/^#\s?/, '')).join(' ');
  assert.match(comment, /security update PRs only against the default branch main/);
  assert.match(comment, /target-branch: dev/);
});

test('the Azure pipeline file is gone', () => {
  // Built from parts: no tracked file names the removed file (tests/repo/legacy-cleanup.mjs).
  const removed = ['azure', 'pipelines.yml'].join('-');
  assert.ok(!existsSync(path.join(repositoryRoot, removed)), removed + ' is deleted');
});
