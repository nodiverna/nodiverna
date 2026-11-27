// The workflow .github/workflows/docs-wiki.yml that mirrors ServerDesk/docs/
// into the GitHub wiki: its name and triggers (push to main on the docs paths,
// dispatch without inputs, no pull_request or schedule), least privilege (read
// at the top, contents: write only on the job, no secrets, the token only in
// the publish step), the repository and branch guard, the runner, time limit
// and concurrency, the steps and their order without a package install, the
// publish script (wiki clone, token as a per-command header, clone error, full
// replace, no-change exit, bot commit, push without --force), and the header
// comment. tests/repo/ci-workflow.mjs checks the SHA pins of its actions.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { repositoryRoot } from '../support/paths.mjs';

const require = createRequire(import.meta.url);
// js-yaml is an existing ESLint dependency, not a new application dependency.
const yaml = createRequire(require.resolve('eslint/package.json'))('js-yaml');
const workflowText = (await readFile(path.join(repositoryRoot, '.github', 'workflows', 'docs-wiki.yml'), 'utf8')).replaceAll('\r\n', '\n');
const workflow = yaml.load(workflowText);
const jobs = workflow.jobs ?? {};
const job = jobs.mirror ?? {};
const steps = job.steps ?? [];
const step = name => steps.find(entry => entry.name === name) ?? {};
const header = workflowText.slice(0, workflowText.indexOf('\nname:')).split('\n').map(line => line.replace(/^#\s?/, '')).join(' ');
const publish = step('Publish the wiki').run ?? '';

test('the workflow Docs wiki runs on pushes to main that touch the docs, and by hand', () => {
  assert.equal(workflow.name, 'Docs wiki');
  assert.deepEqual(Object.keys(workflow.on).sort(), ['push', 'workflow_dispatch']);
  assert.deepEqual(workflow.on.push, {
    branches: ['main'],
    paths: ['ServerDesk/docs/**', 'ServerDesk/scripts/wiki-mirror.mjs', '.github/workflows/docs-wiki.yml'],
  });
  assert.ok(workflow.on.workflow_dispatch === null || typeof workflow.on.workflow_dispatch === 'object');
  assert.equal(workflow.on.workflow_dispatch?.inputs, undefined, 'dispatch without inputs');
  assert.doesNotMatch(workflowText, /pull_request_target/);
  assert.doesNotMatch(workflowText, /pull_request/);
  assert.ok(!('schedule' in workflow.on), 'no schedule');
});

test('only the job has contents: write, without secrets, environment or services, and the token reaches only the publish step', () => {
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(Object.keys(jobs), ['mirror']);
  assert.equal(job.name, 'Mirror the docs into the wiki');
  assert.deepEqual(job.permissions, { contents: 'write' });
  assert.doesNotMatch(workflowText, /secrets\./, 'no secrets');
  assert.ok(!('environment' in workflow) && !('environment' in job), 'no environment');
  assert.ok(!('services' in job), 'no services');
  assert.ok(!('env' in workflow) && !('env' in job), 'no workflow or job env');
  for (const entry of steps) {
    if (entry.name === 'Publish the wiki') assert.deepEqual(entry.env, { GH_TOKEN: '${{ github.token }}' });
    else assert.ok(!('env' in entry), `no env in ${entry.name}`);
  }
  assert.equal(workflowText.match(/github\.token/g)?.length, 1, 'github.token appears once');
  assert.doesNotMatch(workflowText, /GITHUB_TOKEN/);
});

test('the job runs only on main of nodiverna/nodiverna, on ubuntu-latest, within 10 minutes, one run at a time', () => {
  assert.equal(job.if, "github.repository == 'nodiverna/nodiverna' && github.ref == 'refs/heads/main'");
  assert.equal(job['runs-on'], 'ubuntu-latest');
  assert.equal(typeof job['timeout-minutes'], 'number');
  assert.ok(job['timeout-minutes'] > 0 && job['timeout-minutes'] <= 10, `timeout-minutes ${job['timeout-minutes']}`);
  const concurrency = job.concurrency ?? workflow.concurrency;
  assert.deepEqual(concurrency, { group: 'docs-wiki', 'cancel-in-progress': false });
});

test('the steps check out, set up Node.js 22, build the pages and publish them, without a package install', () => {
  assert.deepEqual(steps.map(entry => entry.name), ['Check out', 'Set up Node.js', 'Build the wiki pages', 'Publish the wiki']);
  assert.match(steps[0].uses, /^actions\/checkout@[0-9a-f]{40}$/);
  assert.equal(steps[0].with?.['persist-credentials'], false);
  assert.match(steps[1].uses, /^actions\/setup-node@[0-9a-f]{40}$/);
  assert.equal(String(steps[1].with?.['node-version']), '22');
  assert.equal(steps[2]['working-directory'], 'ServerDesk');
  assert.equal(steps[2].run.trim(), 'node scripts/wiki-mirror.mjs --out "$RUNNER_TEMP/wiki-pages"');
  assert.doesNotMatch(workflowText, /\bpnpm\b/);
  assert.doesNotMatch(workflowText, /\bnpm\b/);
  assert.doesNotMatch(workflowText, /corepack/);
  assert.doesNotMatch(workflowText, /pipeline\.mjs/);
});

test('the publish step replaces the wiki with the pages and keeps the token out of URLs, config and log', () => {
  assert.match(publish, /\.wiki\.git/);
  assert.match(publish, /\$RUNNER_TEMP\/wiki\b/);
  assert.match(publish, /git -c http\.extraheader="\$header" clone /, 'the clone authenticates through a per-command header');
  assert.match(publish, /-c http\.extraheader="\$header" push /, 'the push authenticates through a per-command header');
  assert.match(publish, /\$GH_TOKEN/);
  assert.match(publish, /::add-mask::/, 'the encoded token is masked in the log');
  assert.doesNotMatch(publish, /x-access-token:[^\n]*@github\.com/, 'no token in a URL');
  assert.doesNotMatch(publish, /https:\/\/[^\s"]*\$\{?GH_TOKEN/, 'no token in a URL');
  assert.doesNotMatch(publish, /git[^\n]*\bconfig\b[^\n]*extraheader/, 'no header in .git/config');
  assert.ok(publish.includes('::error::Could not clone the wiki. Create the first wiki page in the GitHub UI once, then run this workflow again.'));
  assert.match(publish, /! -name \.git -exec rm -rf/, 'everything except .git is removed');
  assert.ok(publish.includes('cp -R "$RUNNER_TEMP/wiki-pages/." "$wiki/"'));
  assert.match(publish, /git -C "\$wiki" add -A/);
  assert.match(publish, /diff --cached --quiet/);
  assert.ok(publish.includes('echo "The wiki is up to date."'));
  assert.ok(publish.includes("user.name='github-actions[bot]'"));
  assert.ok(publish.includes("user.email='41898282+github-actions[bot]@users.noreply.github.com'"));
  assert.ok(publish.includes('-m "Mirror ServerDesk/docs at $GITHUB_SHA"'));
  assert.match(publish, /push origin "HEAD:refs\/heads\/\$branch"/);
  assert.doesNotMatch(workflowText, /--force|\bpush\b[^\n]*\s-f\b|\+HEAD/, 'no forced push');
  assert.ok(publish.indexOf('add -A') < publish.indexOf('The wiki is up to date.') && publish.indexOf('The wiki is up to date.') < publish.indexOf(' commit '), 'the no-change exit comes before the commit');
});

test('the header comment explains the source, the rules, the token, the guard, the setup and this test', () => {
  for (const phrase of [
    'ServerDesk/docs/ is the source',
    'replaces the whole wiki',
    'Nobody edits the wiki',
    'only contents: write and the built-in token, and no secrets',
    'only on main of nodiverna/nodiverna',
    'must be initialised once in the GitHub UI',
    'tests/repo/docs-wiki-workflow.mjs checks this file',
  ]) assert.ok(header.includes(phrase), `header says: ${phrase}`);
});
