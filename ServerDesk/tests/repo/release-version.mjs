import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { dockerHubTagCheck, dockerHubTagUrl, latestReleaseTag, planRelease, releaseNotesHeader } from '../../scripts/app-release.mjs';
import { serverDeskRoot, repositoryRoot } from '../support/paths.mjs';

// App versioning: the next SemVer from the vX.Y.Z tags, the release
// guards, the notes header, the plan CLI, and the version in the image.
const root = serverDeskRoot;
const repository = repositoryRoot;
const script = path.join(root, 'scripts', 'app-release.mjs');
const sha = '0123456789abcdef0123456789abcdef01234567';
const main = 'refs/heads/main';
const plan = (bump, tags = [], extra = {}) => planRelease({ bump, ref: main, tags, headTags: [], sha, ...extra });

test('without a valid tag, patch and minor both give v0.1.0', () => {
  for (const bump of ['patch', 'minor']) {
    assert.deepEqual(plan(bump), { release: true, version: '0.1.0', tag: 'v0.1.0', previousTag: null, channel: 'release' });
    assert.deepEqual(plan(bump, ['v0.2.0-rc.1', 'latest', 'agent-v4.7.3']), { release: true, version: '0.1.0', tag: 'v0.1.0', previousTag: null, channel: 'release' });
  }
});

test('patch and minor count up from the highest tag by numeric order', () => {
  assert.deepEqual(plan('patch', ['v0.1.0']), { release: true, version: '0.1.1', tag: 'v0.1.1', previousTag: 'v0.1.0', channel: 'release' });
  assert.deepEqual(plan('minor', ['v0.1.0']), { release: true, version: '0.2.0', tag: 'v0.2.0', previousTag: 'v0.1.0', channel: 'release' });
  const tags = ['v0.1.9', 'v0.1.10', 'v0.1.2'];
  assert.equal(latestReleaseTag(tags).tag, 'v0.1.10');
  assert.deepEqual(plan('patch', tags), { release: true, version: '0.1.11', tag: 'v0.1.11', previousTag: 'v0.1.10', channel: 'release' });
  assert.deepEqual(plan('minor', tags), { release: true, version: '0.2.0', tag: 'v0.2.0', previousTag: 'v0.1.10', channel: 'release' });
  assert.equal(plan('patch', ['v1.0.0', 'v0.9.99']).version, '1.0.1');
  assert.equal(plan('minor', ['v0.10.0', 'v0.9.0']).version, '0.11.0');
});

test('pre-release, build metadata, leading zeros, incomplete and foreign tags are ignored, also when they are higher', () => {
  const noise = ['v0.2.0-rc.1', 'v0.9.0+build.5', 'v01.2.3', 'v0.01.0', 'v0.1.07', 'v1.2', 'v9', 'v1.2.3.4', 'V0.5.0', '0.5.0', 'v0.5.0 ', 'agent-v4.7.3', 'latest', 'edge', ''];
  assert.equal(latestReleaseTag(noise), null);
  assert.deepEqual(plan('patch', ['v0.1.0', ...noise]), { release: true, version: '0.1.1', tag: 'v0.1.1', previousTag: 'v0.1.0', channel: 'release' });
  assert.deepEqual(plan('minor', [...noise, 'v0.1.0']), { release: true, version: '0.2.0', tag: 'v0.2.0', previousTag: 'v0.1.0', channel: 'release' });
});

test('only patch, minor and none are release types', () => {
  for (const bump of ['major', '', 'foo', 'Patch', undefined]) {
    assert.throws(() => plan(bump), error => error.message === `Unknown release type "${bump}". Use patch, minor or none.`, String(bump));
  }
});

test('patch and minor run only from main, also not from dev', () => {
  for (const bump of ['patch', 'minor']) {
    for (const ref of ['refs/heads/dev', 'refs/heads/feature', 'refs/tags/v0.1.0', 'refs/pull/1/merge', 'main', '']) {
      assert.throws(() => plan(bump, [], { ref }), { message: `Releases run only from main (got ${ref}).` });
    }
  }
});

test('none runs only from main or dev', () => {
  for (const ref of ['refs/heads/feature', 'refs/tags/v0.1.0', 'refs/pull/1/merge', 'dev', 'main', 'refs/heads/main2', 'toString', '__proto__', '']) {
    assert.throws(() => plan('none', ['v0.1.0'], { ref }), { message: `Image builds without a release run only from main or dev (got ${ref}).` }, ref);
  }
});

test('a HEAD with a release tag is not released again, and the error names the tag', () => {
  for (const bump of ['patch', 'minor']) {
    assert.throws(() => plan(bump, ['v0.1.0', 'v0.1.1'], { headTags: ['v0.1.1'] }), { message: 'HEAD is already released as v0.1.1. Push a new commit first.' });
  }
  // Tags that are no release tags do not block.
  assert.equal(plan('patch', ['v0.1.0'], { headTags: ['v0.2.0-rc.1', 'agent-v4.7.3'] }).version, '0.1.1');
  // An edge build of a released commit is fine.
  assert.equal(plan('none', ['v0.1.0'], { headTags: ['v0.1.0'] }).version, 'edge-0123456');
});

test('none gives edge-<sha7> on main and dev-<sha7> on dev, and no release', () => {
  assert.deepEqual(plan('none', [], { sha: 'ABCDEF1234567890' }), { release: false, version: 'edge-abcdef1', tag: null, previousTag: null, channel: 'edge' });
  assert.deepEqual(plan('none', ['v0.1.0']), { release: false, version: 'edge-0123456', tag: null, previousTag: 'v0.1.0', channel: 'edge' });
  const dev = { ref: 'refs/heads/dev' };
  assert.deepEqual(plan('none', ['v0.1.0'], dev), { release: false, version: 'dev-0123456', tag: null, previousTag: 'v0.1.0', channel: 'dev' });
  assert.deepEqual(plan('none', [], { ...dev, sha: 'ABCDEF1234567890' }), { release: false, version: 'dev-abcdef1', tag: null, previousTag: null, channel: 'dev' });
  // A tagged HEAD does not block a dev build either.
  assert.deepEqual(plan('none', ['v0.1.0'], { ...dev, headTags: ['v0.1.0'] }), { release: false, version: 'dev-0123456', tag: null, previousTag: 'v0.1.0', channel: 'dev' });
  for (const ref of ['refs/heads/main', 'refs/heads/dev']) {
    for (const bad of ['', '012345', 'xyz1234', '0123456789abcdef0123456789abcdef01234567 ']) {
      assert.throws(() => plan('none', [], { ref, sha: bad }), { message: `An image build needs the commit SHA (got "${bad}").` });
    }
  }
});

test('the release notes header has the exact text and names no agent: the image holds none', () => {
  assert.equal(releaseNotesHeader({ image: 'docker.io/lostindreamz/nodiverna', version: '0.1.1' }),
    'Image: `docker pull docker.io/lostindreamz/nodiverna:0.1.1`');
});

test('the Docker Hub check URL names the namespace, the repository and the tag', () => {
  const url = 'https://hub.docker.com/v2/namespaces/lostindreamz/repositories/nodiverna/tags/0.1.1';
  assert.equal(dockerHubTagUrl('docker.io/lostindreamz/nodiverna', '0.1.1'), url);
  assert.equal(dockerHubTagUrl('lostindreamz/nodiverna', '0.1.1'), url);
  for (const image of ['nodiverna', 'ghcr.io/lostindreamz/nodiverna', 'docker.io/library/a/b', 'docker.io/LostInDreamZ/nodiverna', 'docker.io/lostindreamz/nodiverna:latest', '', undefined]) {
    assert.throws(() => dockerHubTagUrl(image, '0.1.1'), { message: `Image "${image}" must be docker.io/<namespace>/<repository>.` }, String(image));
  }
  for (const tag of ['', '../x', '0.1.1/../2', '-x']) assert.throws(() => dockerHubTagUrl('docker.io/lostindreamz/nodiverna', tag), { message: `Image tag "${tag}" is not valid.` });
});

test('the Docker Hub check passes only for 404 and fails closed on every other status', () => {
  const image = 'docker.io/lostindreamz/nodiverna';
  assert.equal(dockerHubTagCheck(404, image, '0.1.1'), undefined);
  assert.throws(() => dockerHubTagCheck(200, image, '0.1.1'), { message: 'Docker Hub already has docker.io/lostindreamz/nodiverna:0.1.1. Re-run the failed jobs of the first run, or delete the Docker Hub tag first.' });
  for (const status of [500, 429, 401, 301, 0]) {
    assert.throws(() => dockerHubTagCheck(status, image, '0.1.1'), { message: `Cannot check Docker Hub for docker.io/lostindreamz/nodiverna:0.1.1 (HTTP ${status}).` });
  }
});

test('the check-hub CLI refuses a wrong image and wrong options before any request', () => {
  const cli = args => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  const image = cli(['check-hub', '--image', 'ghcr.io/lostindreamz/nodiverna', '--version', '0.1.1']);
  assert.equal(image.status, 1);
  assert.equal(image.stderr.trim(), 'Image "ghcr.io/lostindreamz/nodiverna" must be docker.io/<namespace>/<repository>.');
  for (const args of [['check-hub', '--image', 'docker.io/a/b'], ['check-hub', '--version', '0.1.1'], ['check-hub', '--image', 'docker.io/a/b', '--version', '0.1.1', '--bump', 'patch']]) {
    const failed = cli(args);
    assert.equal(failed.status, 1);
    assert.ok(failed.stderr.includes('Usage: node scripts/app-release.mjs'), failed.stderr);
  }
});

test('the plan CLI reads the tags of a Git repository and prints JSON or writes GITHUB_OUTPUT', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'serverdesk-release-'));
  try {
    const git = (...args) => {
      const result = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd: directory, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git('init', '--quiet', '--initial-branch=main');
    git('commit', '--quiet', '--allow-empty', '-m', 'first');
    git('tag', 'v0.1.9'); git('tag', 'v0.1.10'); git('tag', 'v0.3.0-rc.1');
    git('commit', '--quiet', '--allow-empty', '-m', 'second');
    const head = git('rev-parse', 'HEAD');
    const base = { ...process.env };
    for (const name of ['GITHUB_OUTPUT', 'GITHUB_REF', 'GITHUB_SHA']) delete base[name];
    const cli = (args, env = {}) => spawnSync(process.execPath, [script, ...args], { cwd: directory, encoding: 'utf8', env: { ...base, ...env } });

    const printed = cli(['plan', '--bump', 'patch'], { GITHUB_REF: main, GITHUB_SHA: head });
    assert.equal(printed.status, 0, printed.stderr);
    assert.deepEqual(JSON.parse(printed.stdout), {
      version: '0.1.11', tag: 'v0.1.11', previous_tag: 'v0.1.10', release: 'true', channel: 'release',
      notes: 'Image: `docker pull docker.io/lostindreamz/nodiverna:0.1.11`',
    });
    // Without GITHUB_REF/GITHUB_SHA the CLI reads them from Git.
    assert.equal(JSON.parse(cli(['plan', '--bump', 'minor']).stdout).tag, 'v0.2.0');
    const edge = JSON.parse(cli(['plan', '--bump', 'none'], { GITHUB_REF: main, GITHUB_SHA: head }).stdout);
    assert.deepEqual(edge, { version: `edge-${head.slice(0, 7)}`, tag: '', previous_tag: 'v0.1.10', release: 'false', channel: 'edge', notes: '' });
    const dev = JSON.parse(cli(['plan', '--bump', 'none'], { GITHUB_REF: 'refs/heads/dev', GITHUB_SHA: head }).stdout);
    assert.deepEqual(dev, { version: `dev-${head.slice(0, 7)}`, tag: '', previous_tag: 'v0.1.10', release: 'false', channel: 'dev', notes: '' });

    const outputFile = path.join(directory, 'github-output');
    await writeFile(outputFile, 'earlier=1\n');
    const written = cli(['plan', '--bump', 'minor', '--image', 'docker.io/example/app'], { GITHUB_REF: main, GITHUB_SHA: head, GITHUB_OUTPUT: outputFile });
    assert.equal(written.status, 0, written.stderr);
    const output = await readFile(outputFile, 'utf8');
    assert.ok(output.startsWith('earlier=1\nversion=0.2.0\ntag=v0.2.0\nprevious_tag=v0.1.10\n'), output);
    assert.ok(output.includes('previous_tag=v0.1.10\nrelease=true\nchannel=release\n'), output);
    assert.doesNotMatch(output, /agent/i, 'no agent version in the outputs');
    // The notes are one line now, so they need no heredoc delimiter.
    assert.ok(output.endsWith('release=true\nchannel=release\nnotes=Image: `docker pull docker.io/example/app:0.2.0`\n'), output);

    for (const [args, env, message] of [
      [['plan', '--bump', 'major'], { GITHUB_REF: main, GITHUB_SHA: head }, 'Unknown release type "major". Use patch, minor or none.'],
      [['plan', '--bump', 'patch'], { GITHUB_REF: 'refs/heads/feature', GITHUB_SHA: head }, 'Releases run only from main (got refs/heads/feature).'],
      [['plan', '--bump', 'patch'], { GITHUB_REF: 'refs/heads/dev', GITHUB_SHA: head }, 'Releases run only from main (got refs/heads/dev).'],
      [['plan', '--bump', 'none'], { GITHUB_REF: 'refs/heads/feature', GITHUB_SHA: head }, 'Image builds without a release run only from main or dev (got refs/heads/feature).'],
      [['plan'], {}, 'Usage: node scripts/app-release.mjs plan'],
    ]) {
      const failed = cli(args, { ...env, GITHUB_OUTPUT: path.join(directory, 'unused-output') });
      assert.notEqual(failed.status, 0);
      assert.ok(failed.stderr.includes(message), failed.stderr);
      assert.ok(!existsSync(path.join(directory, 'unused-output')), 'no output after an error');
    }
    git('tag', 'v0.1.11');
    const tagged = cli(['plan', '--bump', 'patch'], { GITHUB_REF: main, GITHUB_SHA: head });
    assert.equal(tagged.status, 1);
    assert.equal(tagged.stderr.trim(), 'HEAD is already released as v0.1.11. Push a new commit first.');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the runtime stage gets the version as ENV and OCI label, the build stage does not', async () => {
  const dockerfile = (await readFile(path.join(root, 'Dockerfile'), 'utf8')).replaceAll('\r\n', '\n');
  const stages = Object.fromEntries(dockerfile.split(/^(?=FROM )/m).filter(stage => stage.startsWith('FROM ')).map(stage => [stage.match(/ AS (\S+)/)[1], stage]));
  const runtime = stages.runtime.split('\n');
  assert.ok(runtime.includes('ARG SERVERDESK_VERSION=dev'));
  assert.ok(runtime.includes('ENV SERVERDESK_VERSION=$SERVERDESK_VERSION'));
  assert.ok(runtime.includes('LABEL org.opencontainers.image.version=$SERVERDESK_VERSION'));
  assert.ok(runtime.indexOf('ARG SERVERDESK_VERSION=dev') < runtime.indexOf('ENV SERVERDESK_VERSION=$SERVERDESK_VERSION'));
  for (const name of ['dependencies', 'development', 'build']) assert.doesNotMatch(stages[name], /SERVERDESK_VERSION/, name);
  assert.doesNotMatch(dockerfile.slice(0, dockerfile.indexOf('FROM ')), /SERVERDESK_VERSION/, 'no global ARG');
});

test('the root README header has the title and the workflow badge, and the docs link the GitHub releases', async () => {
  // The centered HTML header of README.md: everything before the first "## " line.
  const readme = (await readFile(path.join(repository, 'README.md'), 'utf8')).replaceAll('\r\n', '\n');
  const header = readme.slice(0, readme.search(/^## /m));
  assert.ok(header.includes('<h1 align="center">Nodiverna</h1>'), 'the header has the title Nodiverna');
  const workflow = 'https://github.com/LostInDreamZ/nodiverna/actions/workflows/docker-image.yml';
  assert.ok(header.includes(`<a href="${workflow}"><img src="${workflow}/badge.svg" alt="Docker image"></a>`), 'the header has the Docker image workflow badge');
  assert.match(await readFile(path.join(root, 'README.md'), 'utf8'), /\]\(https:\/\/github\.com\/LostInDreamZ\/nodiverna\/releases\)/);
  const selfHosting = await readFile(path.join(root, 'docs', 'self-hosting.md'), 'utf8');
  assert.match(selfHosting, /nodiverna:<version>` to `\.env\.runtime`, for example `0\.1\.1`/);
  assert.doesNotMatch(selfHosting, /`4\.7\.0`/);
  assert.match(selfHosting, /\[Releases\]\(https:\/\/github\.com\/LostInDreamZ\/nodiverna\/releases\)/);
});
