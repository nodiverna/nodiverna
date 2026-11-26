import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { existsSync, symlinkSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { agentDevNotesLine, agentReleaseAssets, agentReleaseNotes, agentReleaseNotesLimit, agentReleasePartSize, buildDigests, earlierAgentChangelogs, planAgentRelease, stageAgentBuild, verifyAgentRelease } from '../../scripts/agent-release.mjs';
import { releaseManifestForm } from '../../runtime/release-manifest.mjs';
import { serverDeskRoot, repositoryRoot } from '../support/paths.mjs';

// Agent releases from the CI: the plan, the check of a signed record
// against the pinned key, the release assets and notes, and the workflow.
// Dev pre-releases: the plan on dev (agent-vX.Y.Z-dev.<sha7>, no changelog),
// the dev version through stage, digests, assets and verify, the build
// version, the generated changelog of the signing script, the first notes line
// and the workflow conditions with --prerelease only on the dev path.
const root = serverDeskRoot;
const repository = repositoryRoot;
const script = path.join(root, 'scripts', 'agent-release.mjs');
const require = createRequire(import.meta.url);
// js-yaml is an existing ESLint dependency, not a new application dependency.
const yaml = createRequire(require.resolve('eslint/package.json'))('js-yaml');
const main = 'refs/heads/main';
const dev = 'refs/heads/dev';
const devSha = 'abc1234def567890abcdef1234567890abcdef12';
const csproj = version => `<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <AssemblyName>ServerDesk.Agent</AssemblyName><Version>${version}</Version>\n  </PropertyGroup>\n  <ItemGroup>\n    <PackageReference Include="SIPSorcery" Version="10.0.17" />\n  </ItemGroup>\n</Project>\n`;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
// Every process the test starts gets the env of this process without any
// GITHUB_* variable, plus only what a case sets itself. On GitHub Actions the
// runner sets GITHUB_SHA, GITHUB_REF, GITHUB_OUTPUT and GITHUB_STEP_SUMMARY; an
// inherited GITHUB_SHA made the plan take the runner's commit instead of the
// HEAD of the temporary repository.
const childEnv = (extra = {}) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GITHUB_'))), ...extra });

const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' });
const otherPem = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ type: 'spki', format: 'pem' });

/** The 20 MiB parts of a file as the build writes them, or none for a small file. */
const partsOf = (bytes, name) => bytes.length <= agentReleasePartSize ? undefined
  : Array.from({ length: Math.ceil(bytes.length / agentReleasePartSize) }, (_, index) => {
    const slice = bytes.subarray(index * agentReleasePartSize, (index + 1) * agentReleasePartSize);
    return { path: `/downloads/${name}.part${index + 1}`, sha256: hash(slice), size: slice.length };
  });
/** A record as scripts/sign-agent-release.mjs writes it (path form), signed with the test key. */
function signed({ version = '4.7.4', zip = Buffer.from('zip bytes of the agent'), exe = Buffer.from('exe bytes of the agent'), changelog = { features: ['A'], fixes: ['B', 'C'] }, mutate = manifest => manifest } = {}) {
  const zipName = `ServerDesk-Agent-${version}-win-x64.zip`, exeName = `ServerDesk-Agent-${version}-win-x64.exe`;
  const zipParts = partsOf(zip, zipName), exeParts = partsOf(exe, exeName);
  const manifest = JSON.stringify(mutate({
    version, protocolVersion: 3, minProtocolVersion: 3, os: ['Windows Server 2022', 'Windows Server 2025', 'Windows 11 Pro', 'Windows 11 Enterprise'], arch: 'x64',
    path: `/downloads/${zipName}`, sha256: hash(zip), size: zip.length, layout: 'single-exe',
    exe: { path: `/downloads/${exeName}`, sha256: hash(exe), size: exe.length, ...(exeParts ? { parts: exeParts } : {}) },
    ...(zipParts ? { parts: zipParts } : {}), ...(changelog ? { changelog } : {}), createdAt: '2026-10-20T10:00:00.000Z',
  }));
  const record = { id: randomUUID(), version, manifest, sha256: hash(zip), size: zip.length, createdAt: 1792058400000 };
  record.signature = sign('sha256', Buffer.from(manifest), { key: keys.privateKey, dsaEncoding: 'der' }).toString('base64');
  return { record, zip, exe };
}
/** The absolute form of a path-form manifest: each path becomes a URL on the origin, at the same key position. */
const toUrls = (manifest, origin = 'https://serverdesk.invalid') => JSON.parse(JSON.stringify(manifest), (_key, item) => item && typeof item === 'object' && !Array.isArray(item) && Object.hasOwn(item, 'path')
  ? Object.fromEntries(Object.entries(item).map(([key, entry]) => key === 'path' ? ['url', origin + entry] : [key, entry])) : item);
const absoluteMessage = 'The agent release manifest has the absolute form with URLs. Sign it again with scripts/sign-agent-release.mjs to get the path form.';
const verifyMessage = (input, message) => assert.throws(() => verifyAgentRelease({ publicKeyPem, version: '4.7.4', ...input }), error => error.message === message, message);

test('the plan releases a version without a tag and ends without a release when the exact tag exists', () => {
  const plan = (tags, extra = {}) => planAgentRelease({ csproj: csproj('4.7.4'), ref: main, tags, ...extra });
  assert.deepEqual(plan([]), { version: '4.7.4', tag: 'agent-v4.7.4', release: true, prerelease: false });
  assert.deepEqual(plan(['agent-v4.7.3', 'agent-v4.7.4', 'v0.1.0']), { version: '4.7.4', tag: 'agent-v4.7.4', release: false, prerelease: false });
  // Only the exact tag counts.
  assert.deepEqual(plan(['agent-v4.7.30', 'agent-v4.7.4-rc.1', 'v4.7.4', 'agent-v04.7.4', 'agent-v4.7.4 ', 'Agent-v4.7.4']), { version: '4.7.4', tag: 'agent-v4.7.4', release: true, prerelease: false });
  // The other Version attributes of the project file do not count.
  assert.equal(planAgentRelease({ csproj: csproj('10.0.1'), ref: main }).version, '10.0.1');
});

test('the plan runs only from main or dev', () => {
  for (const ref of ['refs/heads/feature', 'refs/tags/agent-v4.7.4', 'refs/pull/1/merge', 'main', 'dev', 'refs/heads/dev2', '']) {
    assert.throws(() => planAgentRelease({ csproj: csproj('4.7.4'), ref, sha: devSha }), { message: `Agent releases run only from main or dev (got ${ref}).` });
  }
});

test('the plan on dev builds the pre-release X.Y.Z-dev.<sha7> without a changelog', () => {
  const plan = (tags = [], sha = devSha) => planAgentRelease({ csproj: csproj('4.7.5'), ref: dev, tags, sha });
  assert.deepEqual(plan(), { version: '4.7.5-dev.abc1234', tag: 'agent-v4.7.5-dev.abc1234', release: true, prerelease: true });
  assert.deepEqual(plan(['agent-v4.7.4', 'agent-v4.7.5-dev.0000000']), { version: '4.7.5-dev.abc1234', tag: 'agent-v4.7.5-dev.abc1234', release: true, prerelease: true });
  // The dev tag of this commit exists: no new release, like an existing tag on main.
  assert.deepEqual(plan(['agent-v4.7.5-dev.abc1234']), { version: '4.7.5-dev.abc1234', tag: 'agent-v4.7.5-dev.abc1234', release: false, prerelease: true });
  // A released base: a dev build would rank below it.
  assert.throws(() => plan(['agent-v4.7.5']), { message: 'Agent 4.7.5 is already released as agent-v4.7.5. Increase <Version> on dev to build a dev release.' });
  // The SHA must be 40 hex characters; the version takes the first 7 in lowercase.
  assert.throws(() => planAgentRelease({ csproj: csproj('4.7.5'), ref: dev }), /40 hex characters/);
  for (const sha of ['', 'abc1234', devSha.slice(0, 39), devSha + '0', 'g'.repeat(40)]) assert.throws(() => plan([], sha), /40 hex characters/);
  assert.equal(plan([], devSha.toUpperCase()).version, '4.7.5-dev.abc1234');
  // The base still follows the rule of main.
  assert.throws(() => planAgentRelease({ csproj: csproj('4.7'), ref: dev, sha: devSha }), { message: 'Agent version "4.7" in agent/v3/ServerDesk.Agent.csproj must be X.Y.Z.' });
});

test('the plan refuses a missing version and a version that is not X.Y.Z', () => {
  for (const text of ['<Project></Project>', '<Project><Version></Version></Project>', '', undefined]) {
    assert.throws(() => planAgentRelease({ csproj: text, ref: main }), { message: 'Agent version missing in agent/v3/ServerDesk.Agent.csproj.' });
  }
  for (const version of ['4.7.3.1', '04.7.3', '4.07.3', '4.7', '4.7.3-rc.1', 'v4.7.3', ' 4.7.3']) {
    assert.throws(() => planAgentRelease({ csproj: csproj(version), ref: main }), { message: `Agent version "${version}" in agent/v3/ServerDesk.Agent.csproj must be X.Y.Z.` });
  }
});

test('the plan decides from the project file, the ref and the agent-v* tags only', () => {
  // Release records of earlier builds have no say: only the tag publishes a version.
  assert.deepEqual(planAgentRelease({ csproj: csproj('4.7.4'), ref: main, tags: ['agent-v4.7.3'], builtins: [{ version: '4.7.4', signature: 'x' }] }), { version: '4.7.4', tag: 'agent-v4.7.4', release: true, prerelease: false });
  assert.equal(planAgentRelease.length, 1);
});

test('the plan CLI reads the files and tags of the current directory and writes GITHUB_OUTPUT or JSON', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'serverdesk-agent-release-'));
  try {
    const git = (...args) => {
      const result = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd: directory, encoding: 'utf8', env: childEnv() });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git('init', '--quiet', '--initial-branch=main');
    git('commit', '--quiet', '--allow-empty', '-m', 'first');
    git('tag', 'agent-v4.7.3'); git('tag', 'agent-v4.7.40'); git('tag', 'v4.7.4');
    await mkdir(path.join(directory, 'agent', 'v3', 'changelogs'), { recursive: true });
    await writeFile(path.join(directory, 'agent', 'v3', 'ServerDesk.Agent.csproj'), csproj('4.7.4'));
    await writeFile(path.join(directory, 'agent', 'v3', 'changelogs', '4.7.4.json'), JSON.stringify({ version: '4.7.4', features: ['A'], fixes: [] }));
    const cli = (args, env = {}) => spawnSync(process.execPath, [script, ...args], { cwd: directory, encoding: 'utf8', env: childEnv(env) });

    // Without GITHUB_REF the CLI reads the branch from Git.
    const printed = cli(['plan']);
    assert.equal(printed.status, 0, printed.stderr);
    assert.deepEqual(JSON.parse(printed.stdout), { version: '4.7.4', tag: 'agent-v4.7.4', release: 'true', prerelease: 'false' });

    const outputFile = path.join(directory, 'github-output');
    await writeFile(outputFile, 'earlier=1\n');
    const written = cli(['plan'], { GITHUB_REF: main, GITHUB_OUTPUT: outputFile });
    assert.equal(written.status, 0, written.stderr);
    assert.equal(await readFile(outputFile, 'utf8'), 'earlier=1\nversion=4.7.4\ntag=agent-v4.7.4\nrelease=true\nprerelease=false\n');

    // On dev: the SHA from GITHUB_SHA, else from git rev-parse HEAD; no changelog file of 4.7.4 is needed.
    const head = git('rev-parse', 'HEAD');
    await rm(path.join(directory, 'agent', 'v3', 'changelogs', '4.7.4.json'));
    const devOutput = path.join(directory, 'dev-output');
    const fromEnv = cli(['plan'], { GITHUB_REF: dev, GITHUB_SHA: devSha, GITHUB_OUTPUT: devOutput });
    assert.equal(fromEnv.status, 0, fromEnv.stderr);
    assert.equal(await readFile(devOutput, 'utf8'), 'version=4.7.4-dev.abc1234\ntag=agent-v4.7.4-dev.abc1234\nrelease=true\nprerelease=true\n');
    const fromGit = cli(['plan'], { GITHUB_REF: dev });
    assert.equal(fromGit.status, 0, fromGit.stderr);
    assert.deepEqual(JSON.parse(fromGit.stdout), { version: `4.7.4-dev.${head.slice(0, 7)}`, tag: `agent-v4.7.4-dev.${head.slice(0, 7)}`, release: 'true', prerelease: 'true' });
    git('tag', `agent-v4.7.4-dev.${head.slice(0, 7)}`);
    const again = cli(['plan'], { GITHUB_REF: dev, GITHUB_OUTPUT: devOutput });
    assert.equal(again.status, 0, again.stderr);
    assert.ok(again.stdout.includes('::notice::'), 'an existing dev tag ends with a notice');
    assert.ok((await readFile(devOutput, 'utf8')).endsWith('release=false\nprerelease=true\n'));
    git('tag', '-d', `agent-v4.7.4-dev.${head.slice(0, 7)}`);
    await writeFile(path.join(directory, 'agent', 'v3', 'changelogs', '4.7.4.json'), JSON.stringify({ version: '4.7.4', features: ['A'], fixes: [] }));

    const unused = path.join(directory, 'unused-output');
    const failures = [
      [['plan'], { GITHUB_REF: 'refs/heads/feature' }, 'Agent releases run only from main or dev (got refs/heads/feature).'],
      [['plan', '--out', 'x'], { GITHUB_REF: main }, 'Usage: node scripts/agent-release.mjs plan'],
      [['publish'], { GITHUB_REF: main }, 'Usage: node scripts/agent-release.mjs plan'],
    ];
    for (const [args, env, message] of failures) {
      const failed = cli(args, { ...env, GITHUB_OUTPUT: unused });
      assert.notEqual(failed.status, 0);
      assert.ok(failed.stderr.includes(message), failed.stderr);
      assert.ok(!existsSync(unused), 'no output after an error');
    }
    // A missing or bad changelog stops the run before the build.
    await writeFile(path.join(directory, 'agent', 'v3', 'changelogs', '4.7.4.json'), JSON.stringify({ version: '4.7.4', features: [], fixes: [] }));
    const empty = cli(['plan'], { GITHUB_REF: main, GITHUB_OUTPUT: unused });
    assert.equal(empty.status, 1);
    assert.equal(empty.stderr.trim(), 'A new Agent release requires at least one feature or bugfix.');
    // An invalid earlier changelog stops the run too: the release notes list it.
    await writeFile(path.join(directory, 'agent', 'v3', 'changelogs', '4.7.4.json'), JSON.stringify({ version: '4.7.4', features: ['A'], fixes: [] }));
    await writeFile(path.join(directory, 'agent', 'v3', 'changelogs', '4.7.3.json'), JSON.stringify({ version: '4.7.3', features: [], fixes: [] }));
    const earlier = cli(['plan'], { GITHUB_REF: main, GITHUB_OUTPUT: unused });
    assert.equal(earlier.status, 1);
    assert.equal(earlier.stderr.trim(), 'agent/v3/changelogs/4.7.3.json is not a valid changelog: A new Agent release requires at least one feature or bugfix.');
    await rm(path.join(directory, 'agent', 'v3', 'changelogs', '4.7.3.json'));
    await rm(path.join(directory, 'agent', 'v3', 'changelogs', '4.7.4.json'));
    const missing = cli(['plan'], { GITHUB_REF: main, GITHUB_OUTPUT: unused });
    assert.equal(missing.status, 1);
    assert.equal(missing.stderr.trim(), 'Add agent/v3/changelogs/4.7.4.json with version, features and fixes before publishing a new Agent release.');
    assert.ok(!existsSync(unused), 'no output after an error');
    // An existing tag ends the run with a notice and exit 0; the changelog is not read then.
    git('tag', 'agent-v4.7.4');
    await writeFile(outputFile, '');
    const tagged = cli(['plan'], { GITHUB_REF: main, GITHUB_OUTPUT: outputFile });
    assert.equal(tagged.status, 0, tagged.stderr);
    assert.equal(tagged.stdout.trim(), '::notice::Agent 4.7.4 is already released as agent-v4.7.4. Increase <Version> to release a new agent.');
    assert.equal(await readFile(outputFile, 'utf8'), 'version=4.7.4\ntag=agent-v4.7.4\nrelease=false\nprerelease=false\n');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a signed record and its files pass the check', () => {
  const { record, zip, exe } = signed();
  assert.equal(verifyAgentRelease({ record, files: { zip, exe }, publicKeyPem, version: '4.7.4' }).version, '4.7.4');
  assert.equal(verifyAgentRelease({ record, publicKeyPem, version: '4.7.4' }).exe.sha256, hash(exe));
});

test('the check refuses another key, a changed manifest, a wrong signature, wrong keys and a wrong version', () => {
  const { record } = signed();
  const mismatch = 'The agent release signature does not match agent/v3/release-public.pem.';
  verifyMessage({ record, publicKeyPem: otherPem }, mismatch);
  verifyMessage({ record: { ...record, manifest: record.manifest.replace('Windows 11 Pro', 'Windows 11 Pre') } }, mismatch);
  verifyMessage({ record: { ...record, signature: signed({ version: '4.7.5' }).record.signature } }, mismatch);
  verifyMessage({ record: { ...record, signature: `${record.signature}\n` } }, mismatch);
  verifyMessage({ record: { ...record, signature: 'not base64!' } }, mismatch);
  for (const signature of [undefined, '', null, 7]) {
    const unsigned = { ...record, signature };
    if (signature === undefined) delete unsigned.signature;
    verifyMessage({ record: unsigned }, 'The agent release record has no signature.');
  }
  const keysMessage = 'The agent release record must have exactly the keys id, version, manifest, signature, sha256, size and createdAt.';
  verifyMessage({ record: { ...record, notes: 'x' } }, keysMessage);
  const { createdAt, ...withoutCreatedAt } = record;
  assert.ok(createdAt);
  verifyMessage({ record: withoutCreatedAt }, keysMessage);
  verifyMessage({ record, version: '4.7.5' }, 'The agent release record has version 4.7.4, not 4.7.5.');
  for (const value of [null, [], 'record']) verifyMessage({ record: value }, 'The agent release record is not an object.');
});

test('the check refuses a record that does not match its manifest, and a manifest without the single EXE of protocol 3', () => {
  const message = 'The agent release record does not match its manifest.';
  const { record } = signed();
  verifyMessage({ record: { ...record, sha256: 'a'.repeat(64) } }, message);
  verifyMessage({ record: { ...record, size: record.size + 1 } }, message);
  verifyMessage({ record: { ...record, id: 'not-a-uuid' } }, message);
  for (const mutate of [
    manifest => ({ ...manifest, exe: undefined }),
    manifest => ({ ...manifest, layout: 'zip' }),
    manifest => ({ ...manifest, protocolVersion: 2 }),
    manifest => ({ ...manifest, version: '4.7.5' }),
    manifest => ({ ...manifest, size: manifest.size + 1 }),
  ]) verifyMessage({ record: signed({ mutate }).record }, message);
  const broken = signed();
  verifyMessage({ record: { ...broken.record, manifest: '{not json' } }, message);
});

test('with files, the ZIP and the EXE must have the size and SHA-256 of the signed manifest', () => {
  const { record, zip, exe } = signed();
  const changed = bytes => { const copy = Buffer.from(bytes); copy[0] ^= 1; return copy; };
  verifyMessage({ record, files: { zip: changed(zip), exe } }, 'ServerDesk-Agent-4.7.4-win-x64.zip does not match the signed manifest.');
  verifyMessage({ record, files: { zip: Buffer.concat([zip, Buffer.from('x')]), exe } }, 'ServerDesk-Agent-4.7.4-win-x64.zip does not match the signed manifest.');
  verifyMessage({ record, files: { zip, exe: changed(exe) } }, 'ServerDesk-Agent-4.7.4-win-x64.exe does not match the signed manifest.');
  verifyMessage({ record, files: { zip, exe: exe.subarray(1) } }, 'ServerDesk-Agent-4.7.4-win-x64.exe does not match the signed manifest.');
  verifyMessage({ record, files: { zip } }, 'ServerDesk-Agent-4.7.4-win-x64.exe does not match the signed manifest.');
});

test('the check accepts only the path form with the file names of the version', () => {
  const origin = 'https://serverdesk.invalid';
  verifyMessage({ record: signed({ mutate: manifest => toUrls(manifest) }).record }, absoluteMessage);
  const mixed = 'The agent release manifest mixes file paths and URLs.';
  verifyMessage({ record: signed({ mutate: manifest => ({ ...manifest, exe: toUrls(manifest, origin).exe }) }).record }, mixed);
  verifyMessage({ record: signed({ mutate: manifest => ({ ...manifest, exe: { ...manifest.exe, url: `${origin}${manifest.exe.path}` } }) }).record }, mixed);
  const named = (got, expected) => `The agent release manifest names ${JSON.stringify(got)} where ${expected} is expected.`;
  verifyMessage({ record: signed({ mutate: manifest => ({ ...manifest, path: '/downloads/ServerDesk-Agent-4.7.5-win-x64.zip' }) }).record },
    named('/downloads/ServerDesk-Agent-4.7.5-win-x64.zip', '/downloads/ServerDesk-Agent-4.7.4-win-x64.zip'));
  verifyMessage({ record: signed({ mutate: manifest => ({ ...manifest, exe: { ...manifest.exe, path: '/downloads/agent.exe' } }) }).record },
    named('/downloads/agent.exe', '/downloads/ServerDesk-Agent-4.7.4-win-x64.exe'));
  // Parts are numbered from 1 without gaps.
  const exe = Buffer.alloc(agentReleasePartSize + 7, 3);
  const gap = signed({ exe, mutate: manifest => ({ ...manifest, exe: { ...manifest.exe, parts: manifest.exe.parts.map((part, index) => index ? { ...part, path: part.path.replace('.part2', '.part3') } : part) } }) });
  verifyMessage({ record: gap.record }, named('/downloads/ServerDesk-Agent-4.7.4-win-x64.exe.part3', '/downloads/ServerDesk-Agent-4.7.4-win-x64.exe.part2'));
  const zero = signed({ exe, mutate: manifest => ({ ...manifest, exe: { ...manifest.exe, parts: manifest.exe.parts.map(part => ({ ...part, path: part.path.replace(/part(\d)$/, (_, n) => `part${n - 1}`) })) } }) });
  verifyMessage({ record: zero.record }, named('/downloads/ServerDesk-Agent-4.7.4-win-x64.exe.part0', '/downloads/ServerDesk-Agent-4.7.4-win-x64.exe.part1'));
});

test('with files, each signed part must be the matching consecutive 20 MiB slice of the ZIP or the EXE', () => {
  const zip = Buffer.alloc(agentReleasePartSize + 11);
  for (let index = 0; index < zip.length; index += 4096) zip[index] = index % 251;
  const exe = Buffer.alloc(2 * agentReleasePartSize + 5, 9);
  const good = signed({ zip, exe });
  const manifest = verifyAgentRelease({ record: good.record, files: { zip, exe }, publicKeyPem, version: '4.7.4' });
  assert.deepEqual(manifest.exe.parts.map(part => part.size), [agentReleasePartSize, agentReleasePartSize, 5]);
  assert.deepEqual(manifest.parts.map(part => part.path), ['/downloads/ServerDesk-Agent-4.7.4-win-x64.zip.part1', '/downloads/ServerDesk-Agent-4.7.4-win-x64.zip.part2']);
  // The same sizes and sum, but split at another offset: not the slices of the build.
  const shifted = signed({ zip, exe, mutate: value => {
    const [first, second] = [zip.subarray(0, 10), zip.subarray(10)];
    return { ...value, parts: [{ path: value.parts[0].path, sha256: hash(second.subarray(0, agentReleasePartSize)), size: agentReleasePartSize }, { path: value.parts[1].path, sha256: hash(Buffer.concat([second.subarray(agentReleasePartSize), first])), size: 11 }] };
  } });
  verifyMessage({ record: shifted.record, files: { zip, exe } }, 'ServerDesk-Agent-4.7.4-win-x64.zip.part1 is not the matching 20 MiB slice of ServerDesk-Agent-4.7.4-win-x64.zip.');
  const swapped = signed({ zip, exe, mutate: value => ({ ...value, exe: { ...value.exe, parts: [value.exe.parts[0], { ...value.exe.parts[1], sha256: hash(Buffer.from('other')) }, value.exe.parts[2]] } }) });
  verifyMessage({ record: swapped.record, files: { zip, exe } }, 'ServerDesk-Agent-4.7.4-win-x64.exe.part2 is not the matching 20 MiB slice of ServerDesk-Agent-4.7.4-win-x64.exe.');
  const split = signed({ zip, exe, mutate: value => ({ ...value, exe: { ...value.exe, parts: [
    { path: value.exe.parts[0].path, sha256: hash(exe.subarray(0, 10)), size: 10 },
    { path: value.exe.parts[1].path, sha256: hash(exe.subarray(10, agentReleasePartSize + 10)), size: agentReleasePartSize },
    { path: value.exe.parts[2].path, sha256: hash(exe.subarray(agentReleasePartSize + 10)), size: agentReleasePartSize - 5 },
  ] } }) });
  verifyMessage({ record: split.record, files: { zip, exe } }, 'ServerDesk-Agent-4.7.4-win-x64.exe.part1 is not the matching 20 MiB slice of ServerDesk-Agent-4.7.4-win-x64.exe.');
  // Without files only the record, the signature and the names are checked.
  assert.equal(verifyAgentRelease({ record: split.record, publicKeyPem, version: '4.7.4' }).version, '4.7.4');
});

test('sign-agent-release.mjs needs the key, signs the path form into .build/, checks the parts as slices and keeps the identity of the same artifact', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'serverdesk-agent-sign-'));
  try {
    const version = '4.12.0', zipName = `ServerDesk-Agent-${version}-win-x64.zip`, exeName = `ServerDesk-Agent-${version}-win-x64.exe`;
    const put = async (relative, content) => { await mkdir(path.dirname(path.join(directory, relative)), { recursive: true }); await writeFile(path.join(directory, relative), content); };
    for (const file of ['scripts/sign-agent-release.mjs', 'scripts/release-changelog.mjs', 'runtime/release-manifest.mjs', 'runtime/release-version.mjs', 'runtime/agent-release-verify.mjs']) await put(file, await readFile(path.join(root, file)));
    const zip = Buffer.from('zip bytes of the agent 4.12.0'), exe = Buffer.alloc(agentReleasePartSize + 10);
    for (let index = 0; index < exe.length; index += 4093) exe[index] = index % 241;
    const exeParts = partsOf(exe, exeName);
    const artifact = { version, arch: 'x64', protocolVersion: 3, size: zip.length, sha256: hash(zip), path: `/downloads/${zipName}`, parts: [], layout: 'single-exe', exe: { path: `/downloads/${exeName}`, size: exe.length, sha256: hash(exe), parts: exeParts } };
    await put(`.build/${zipName}`, zip);
    await put('.build/agent-v3-publish/ServerDesk.Agent.exe', exe);
    await put('.build/agent-v3-artifact.json', JSON.stringify(artifact));
    await put('agent/v3/release-public.pem', publicKeyPem);
    await put('lib/release-publisher.json', JSON.stringify({ publicKey: publicKeyPem }));
    const keyFile = path.join(directory, 'release-private.pem');
    await writeFile(keyFile, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const target = path.join(directory, '.build', 'agent-v3-release.json');
    const sign = (env = { SERVERDESK_RELEASE_KEY_FILE: keyFile }) => { const base = childEnv(); delete base.SERVERDESK_RELEASE_KEY_FILE; return spawnSync(process.execPath, ['scripts/sign-agent-release.mjs'], { cwd: directory, encoding: 'utf8', env: { ...base, ...env } }); };
    const run = async (changelog, { keep = false } = {}) => {
      if (!keep) await rm(target, { force: true });
      await put(`agent/v3/changelogs/${version}.json`, JSON.stringify({ version, ...changelog }));
      return sign();
    };
    // Without SERVERDESK_RELEASE_KEY_FILE: exit 1 with an English message, nothing written.
    const keyless = sign({});
    assert.equal(keyless.status, 1);
    assert.equal(keyless.stderr.trim(), 'Set SERVERDESK_RELEASE_KEY_FILE to the publisher private key file. The record is signed with it and checked against agent/v3/release-public.pem.');
    assert.equal(existsSync(target), false);
    const libBefore = await readdir(path.join(directory, 'lib'));
    const signedRun = await run({ features: ['Path form'], fixes: [] });
    assert.equal(signedRun.status, 0, signedRun.stderr);
    const record = JSON.parse(await readFile(target, 'utf8'));
    assert.deepEqual(Object.keys(record), ['id', 'version', 'manifest', 'signature', 'sha256', 'size', 'createdAt']);
    const manifest = JSON.parse(record.manifest);
    assert.equal(releaseManifestForm(manifest), 'path');
    assert.ok(!record.manifest.includes('serverdesk.invalid') && !record.manifest.includes('"url"'), 'no origin in the signed bytes');
    assert.deepEqual([manifest.path, manifest.exe.path, ...manifest.exe.parts.map(part => part.path)], [`/downloads/${zipName}`, `/downloads/${exeName}`, `/downloads/${exeName}.part1`, `/downloads/${exeName}.part2`]);
    assert.deepEqual(Object.keys(manifest), ['version', 'protocolVersion', 'minProtocolVersion', 'os', 'arch', 'path', 'sha256', 'size', 'layout', 'exe', 'changelog', 'createdAt']);
    assert.equal(verifyAgentRelease({ record, files: { zip, exe }, publicKeyPem, version }).version, version, 'the signature is over the path-form bytes, the parts are the slices');
    assert.deepEqual(await readdir(path.join(directory, 'lib')), libBefore, 'nothing is written to lib/');
    assert.equal(existsSync(path.join(directory, 'public')), false, 'nothing is written to public/');
    // Signing the same artifact again keeps the id, the time and the signed bytes.
    const again = await run({ features: ['Other notes'], fixes: [] }, { keep: true });
    assert.equal(again.status, 0, again.stderr);
    const resigned = JSON.parse(await readFile(target, 'utf8'));
    assert.deepEqual([resigned.id, resigned.createdAt, resigned.manifest], [record.id, record.createdAt, record.manifest]);
    // Another key than the pin is refused.
    await writeFile(keyFile, generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const foreign = await run({ features: ['Path form'], fixes: [] });
    assert.equal(foreign.status, 1);
    assert.match(foreign.stderr, /Release signing key does not match the locally pinned publisher key./);
    await writeFile(keyFile, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    // A part that is not the slice of the whole file is refused.
    await put('.build/agent-v3-artifact.json', JSON.stringify({ ...artifact, exe: { ...artifact.exe, parts: [{ ...exeParts[0], sha256: hash(exe.subarray(1, agentReleasePartSize + 1)) }, exeParts[1]] } }));
    const shifted = await run({ features: ['Path form'], fixes: [] });
    assert.equal(shifted.status, 1);
    assert.match(shifted.stderr, /Executable part 1 is not the matching 20 MiB slice of the file./);
    await put('.build/agent-v3-artifact.json', JSON.stringify(artifact));
    // At most 8192 characters of the path form; there is no other form to check.
    const base = record.manifest.length - JSON.stringify({ features: ['Path form'], fixes: [] }).length;
    const refused = 'Signed manifest including release notes exceeds 8192 characters. Shorten the release notes.';
    const tooLong = await run(changelogOfLength(8193 - base));
    assert.equal(tooLong.status, 1, tooLong.stdout);
    assert.equal(tooLong.stderr.split(/\r?\n/).find(line => line.startsWith('Error: '))?.slice(7), refused);
    assert.equal(existsSync(target), false, 'nothing written after a refusal');
    const fits = await run(changelogOfLength(8192 - base));
    assert.equal(fits.status, 0, fits.stderr);
    assert.equal(JSON.parse(await readFile(target, 'utf8')).manifest.length, 8192);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

/**
 * Release notes whose JSON has exactly the given length: full entries of 200
 * quotes (escaped to 400 characters), then one entry of quotes and letters.
 */
function changelogOfLength(target) {
  const changelog = { features: [], fixes: [] }, size = () => JSON.stringify(changelog).length;
  const add = text => { const list = changelog.features.length < 10 ? changelog.features : changelog.fixes; list.push(text); };
  const rest = () => target - size() - ((changelog.features.length < 10 ? changelog.features : changelog.fixes).length ? 3 : 2);
  while (rest() > 600) add('"'.repeat(200));
  if (rest() > 400) add('a'.repeat(200));
  const left = rest(), quotes = Math.max(0, left - 200);
  add('"'.repeat(quotes) + 'a'.repeat(left - 2 * quotes));
  assert.equal(size(), target, 'release notes of the wanted length');
  assert.ok(changelog.fixes.length <= 10, 'at most 20 entries');
  return changelog;
}

test('the assets are the formatted record, the exact signed manifest and the signature without a newline', () => {
  const { record } = signed();
  const assets = agentReleaseAssets(record);
  assert.deepEqual(assets.map(asset => asset.name), ['ServerDesk-Agent-4.7.4-release.json', 'ServerDesk-Agent-4.7.4-manifest.json', 'ServerDesk-Agent-4.7.4-manifest.sig']);
  assert.equal(assets[0].content, JSON.stringify(record, null, 2) + '\n');
  assert.ok(assets[1].content === record.manifest, 'the signed bytes, not formatted again');
  assert.ok(assets[2].content === record.signature, 'the signature, with no newline');
  assert.ok(!assets[2].content.endsWith('\n'));
});

test('the release notes come from the changelog of the signed manifest', () => {
  assert.equal(agentReleaseNotes(signed().record), [
    'Windows agent 4.7.4 (x64, protocol 3)', '', 'Features:', '- A', '', 'Fixes:', '- B', '- C', '',
    'The manifest signature checks against ServerDesk/agent/v3/release-public.pem.',
  ].join('\n'));
  const fixesOnly = agentReleaseNotes(signed({ changelog: { features: [], fixes: ['B'] } }).record);
  assert.equal(fixesOnly, 'Windows agent 4.7.4 (x64, protocol 3)\n\nFixes:\n- B\n\nThe manifest signature checks against ServerDesk/agent/v3/release-public.pem.');
  assert.doesNotMatch(fixesOnly, /Features/);
  const featuresOnly = agentReleaseNotes(signed({ changelog: { features: ['A'], fixes: [] } }).record);
  assert.doesNotMatch(featuresOnly, /Fixes/);
  // Without earlier changelogs the text stays as it was.
  assert.equal(agentReleaseNotes(signed().record, []), agentReleaseNotes(signed().record));
  assert.equal(agentReleaseNotes(signed({ changelog: { features: [], fixes: ['B'] } }).record, []), fixesOnly);
});

test('the release notes list the earlier changelogs of the same major version, newest first, after the signed block', () => {
  const { record } = signed({ version: '4.16.0', changelog: { features: ['Signed feature'], fixes: [] } });
  const earlier = [
    { version: '4.9.0', features: [], fixes: ['Fix of 4.9.0'] },
    { version: '4.10.0', features: ['Feature of 4.10.0'], fixes: ['Fix of 4.10.0', 'Second fix of 4.10.0'] },
    { version: '3.1.0', features: ['Other major'], fixes: [] },
    { version: '4.16.0', features: ['Unsigned file of the current version'], fixes: [] },
    { version: '4.17.0', features: ['Later version'], fixes: [] },
  ];
  const notes = agentReleaseNotes(record, earlier);
  assert.equal(notes, [
    'Windows agent 4.16.0 (x64, protocol 3)', '', 'Features:', '- Signed feature', '',
    'Earlier agent 4 versions, newest first. An update from an older agent also contains these changes.', '',
    '### 4.10.0', '', 'Features:', '- Feature of 4.10.0', '', 'Fixes:', '- Fix of 4.10.0', '- Second fix of 4.10.0', '',
    '### 4.9.0', '', 'Fixes:', '- Fix of 4.9.0', '',
    'The manifest signature checks against ServerDesk/agent/v3/release-public.pem.',
  ].join('\n'));
  assert.ok(notes.indexOf('### 4.10.0') < notes.indexOf('### 4.9.0'), 'semantic order, not text order');
  for (const absent of ['Other major', 'Unsigned file of the current version', 'Later version', '3.1.0', '4.17.0', '### 4.16.0']) assert.ok(!notes.includes(absent), absent);
  // The 4.9.0 block has only fixes: no Features line between its heading and its fixes.
  assert.match(notes, /### 4\.9\.0\n\nFixes:\n- Fix of 4\.9\.0\n/);
  // A small body never names the directory.
  assert.ok(!notes.includes('Older versions:'));
});

test('the release notes drop the oldest earlier versions above 100,000 characters and name the directory', () => {
  const { record } = signed({ version: '4.40.0' });
  const entry = (version, letter) => ({ version, features: Array.from({ length: 10 }, () => letter.repeat(200)), fixes: Array.from({ length: 10 }, () => letter.repeat(200)) });
  // 30 versions of about 4,100 characters each: about 123,000 characters without the cap.
  const earlier = Array.from({ length: 30 }, (_, index) => entry(`4.${index + 10}.0`, String.fromCharCode(97 + (index % 26))));
  const notes = agentReleaseNotes(record, earlier);
  assert.equal(agentReleaseNotesLimit, 100000);
  assert.ok(notes.length <= 100000, String(notes.length));
  const sections = notes.split('\n\n');
  assert.equal(sections.at(-1), 'The manifest signature checks against ServerDesk/agent/v3/release-public.pem.');
  assert.equal(sections.at(-2), 'Older versions: ServerDesk/agent/v3/changelogs in this repository.');
  const kept = [...notes.matchAll(/^### (\S+)$/gm)].map(match => match[1]);
  assert.ok(kept.length > 0 && kept.length < 30, String(kept.length));
  // The newest versions stay and the oldest go.
  assert.deepEqual(kept, Array.from({ length: kept.length }, (_, index) => `4.${39 - index}.0`));
  // Only as many as needed go: one more version would cross the cap again.
  const oneMore = agentReleaseNotes(record, earlier.slice(30 - kept.length - 1));
  assert.equal(oneMore, notes);
  assert.equal(agentReleaseNotes(record, earlier.slice(30 - kept.length)).includes('Older versions:'), false);
});

test('earlierAgentChangelogs reads, validates and selects the changelog files of a directory', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'serverdesk-agent-changelogs-'));
  try {
    const folder = path.join(directory, 'agent', 'v3', 'changelogs');
    assert.deepEqual(earlierAgentChangelogs(directory, '4.16.0'), [], 'no directory, no earlier changelogs');
    await mkdir(folder, { recursive: true });
    const put = (name, value) => writeFile(path.join(folder, name), typeof value === 'string' ? value : JSON.stringify(value));
    await put('4.9.0.json', { version: '4.9.0', features: ['  Feature of 4.9.0  '], fixes: [] });
    await put('4.10.0.json', { version: '4.10.0', features: [], fixes: ['Fix of 4.10.0'] });
    await put('4.16.0.json', { version: '4.16.0', features: ['Current'], fixes: [] });
    await put('4.17.0.json', { version: '4.17.0', features: ['Later'], fixes: [] });
    await put('3.1.0.json', { version: '3.1.0', features: ['Other major'], fixes: [] });
    await put('README.md', 'not a changelog');
    assert.deepEqual(earlierAgentChangelogs(directory, '4.16.0'), [
      { version: '4.10.0', features: [], fixes: ['Fix of 4.10.0'] },
      { version: '4.9.0', features: ['Feature of 4.9.0'], fixes: [] },
    ]);
    const refused = async (name, content, message) => {
      await put(name, content);
      assert.throws(() => earlierAgentChangelogs(directory, '4.16.0'), { message });
      await rm(path.join(folder, name));
    };
    await refused('4.9.json', { version: '4.9', features: ['A'], fixes: [] }, 'agent/v3/changelogs/4.9.json is not a valid changelog: the file name must be X.Y.Z.json.');
    await refused('4.8.0.json', '{"version":', 'agent/v3/changelogs/4.8.0.json is not a valid changelog: the file is not valid JSON.');
    await refused('4.8.0.json', { version: '4.8.0', features: ['x'.repeat(201)], fixes: [] }, 'agent/v3/changelogs/4.8.0.json is not a valid changelog: Release notes features must contain at most 10 nonempty entries of at most 200 characters.');
    // A later version is checked too, though the notes do not list it.
    await refused('4.18.0.json', { version: '4.18.1', features: ['A'], fixes: [] }, 'agent/v3/changelogs/4.18.0.json is not a valid changelog: Release notes must name version 4.18.0 and contain only version, features and fixes.');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the assets and verify CLIs collect and check the files with the key of the current directory only', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'serverdesk-agent-assets-'));
  try {
    const { record, zip, exe } = signed();
    await mkdir(path.join(directory, 'agent', 'v3'), { recursive: true });
    await mkdir(path.join(directory, '.build', 'agent-v3-publish'), { recursive: true });
    await writeFile(path.join(directory, 'agent', 'v3', 'release-public.pem'), publicKeyPem);
    await writeFile(path.join(directory, '.build', 'ServerDesk-Agent-4.7.4-win-x64.zip'), zip);
    await writeFile(path.join(directory, '.build', 'agent-v3-publish', 'ServerDesk.Agent.exe'), exe);
    // Two earlier changelogs of the checkout go into notes.md.
    await mkdir(path.join(directory, 'agent', 'v3', 'changelogs'), { recursive: true });
    await writeFile(path.join(directory, 'agent', 'v3', 'changelogs', '4.7.3.json'), JSON.stringify({ version: '4.7.3', features: [], fixes: ['Fix of 4.7.3'] }));
    await writeFile(path.join(directory, 'agent', 'v3', 'changelogs', '4.6.8.json'), JSON.stringify({ version: '4.6.8', features: ['Feature of 4.6.8'], fixes: [] }));
    const cli = args => spawnSync(process.execPath, [script, ...args], { cwd: directory, encoding: 'utf8', env: childEnv() });
    const out = path.join(directory, 'out');

    const { signature, ...unsigned } = record;
    assert.ok(signature);
    const missing = cli(['assets', '--out', out, '--version', '4.7.4']);
    assert.equal(missing.status, 1);
    assert.equal(missing.stderr.trim(), '.build/agent-v3-release.json is missing. Sign the build with scripts/sign-agent-release.mjs first.');
    await writeFile(path.join(directory, '.build', 'agent-v3-release.json'), JSON.stringify(unsigned, null, 2) + '\n');
    const refused = cli(['assets', '--out', out, '--version', '4.7.4']);
    assert.equal(refused.status, 1);
    assert.equal(refused.stderr.trim(), 'The agent release record has no signature.');
    assert.ok(!existsSync(out), 'nothing written for an unsigned record');

    await writeFile(path.join(directory, '.build', 'agent-v3-release.json'), JSON.stringify(record, null, 2) + '\n');
    const wrongVersion = cli(['assets', '--out', out, '--version', '4.7.5']);
    assert.equal(wrongVersion.status, 1);
    assert.equal(wrongVersion.stderr.trim(), 'The agent release record has version 4.7.4, not 4.7.5.');
    const collected = cli(['assets', '--out', out, '--version', '4.7.4']);
    assert.equal(collected.status, 0, collected.stderr);
    assert.deepEqual((await readdir(out)).sort(), [
      'ServerDesk-Agent-4.7.4-manifest.json', 'ServerDesk-Agent-4.7.4-manifest.sig', 'ServerDesk-Agent-4.7.4-release.json',
      'ServerDesk-Agent-4.7.4-win-x64.exe', 'ServerDesk-Agent-4.7.4-win-x64.zip', 'notes.md',
    ]);
    assert.equal(await readFile(path.join(out, 'ServerDesk-Agent-4.7.4-manifest.json'), 'utf8'), record.manifest);
    assert.equal(await readFile(path.join(out, 'ServerDesk-Agent-4.7.4-manifest.sig'), 'utf8'), record.signature);
    const notes = await readFile(path.join(out, 'notes.md'), 'utf8');
    assert.equal(notes, agentReleaseNotes(record, [{ version: '4.7.3', features: [], fixes: ['Fix of 4.7.3'] }, { version: '4.6.8', features: ['Feature of 4.6.8'], fixes: [] }]) + '\n');
    assert.ok(notes.includes('### 4.7.3\n\nFixes:\n- Fix of 4.7.3') && notes.includes('### 4.6.8\n\nFeatures:\n- Feature of 4.6.8'), notes);
    assert.ok((await readFile(path.join(out, 'ServerDesk-Agent-4.7.4-win-x64.zip'))).equals(zip));

    const verified = cli(['verify', '--dir', out, '--version', '4.7.4']);
    assert.equal(verified.status, 0, verified.stderr);
    assert.equal(verified.stdout.trim(), 'Agent 4.7.4: the release assets match the signature of agent/v3/release-public.pem.');
    const checked = cli(['verify', '--dir', out, '--version', '4.7.4', '--check-notes']);
    assert.equal(checked.status, 0, checked.stderr);
    // notes.md is unsigned: verify alone ignores it, --check-notes compares it.
    const notesDiffer = async label => {
      const plain = cli(['verify', '--dir', out, '--version', '4.7.4']);
      assert.equal(plain.status, 0, `${label}: ${plain.stderr}`);
      const strict = cli(['verify', '--dir', out, '--version', '4.7.4', '--check-notes']);
      assert.equal(strict.status, 1, label);
      assert.equal(strict.stderr.trim(), 'notes.md does not match the signed manifest.', label);
    };
    // A removed earlier section.
    await writeFile(path.join(out, 'notes.md'), notes.replace('### 4.6.8\n\nFeatures:\n- Feature of 4.6.8\n\n', ''));
    await notesDiffer('removed section');
    // A missing notes.md.
    await rm(path.join(out, 'notes.md'));
    await notesDiffer('missing notes.md');
    await writeFile(path.join(out, 'notes.md'), notes);
    assert.equal(cli(['verify', '--dir', out, '--version', '4.7.4', '--check-notes']).status, 0);
    // An earlier changelog of the checkout that changes after assets wrote the folder (a cached NAS release folder).
    const added = path.join(directory, 'agent', 'v3', 'changelogs', '4.7.2.json');
    await writeFile(added, JSON.stringify({ version: '4.7.2', features: [], fixes: ['Fix of 4.7.2'] }));
    await notesDiffer('new earlier changelog');
    await rm(added);
    assert.equal(cli(['verify', '--dir', out, '--version', '4.7.4', '--check-notes']).status, 0);
    // --check-notes belongs to verify only.
    const notesOnAssets = cli(['assets', '--out', out, '--check-notes']);
    assert.equal(notesOnAssets.status, 1);
    assert.match(notesOnAssets.stderr.trim(), /^Usage: node scripts\/agent-release\.mjs .*verify --dir <dir> --version X\.Y\.Z \[--check-notes\]$/);
    for (const args of [['plan', '--check-notes'], ['digests', '--version', '4.7.4', '--check-notes'], ['stage', '--dir', out, '--version', '4.7.4', '--check-notes']]) {
      const result = cli(args);
      assert.equal(result.status, 1, args.join(' '));
      assert.match(result.stderr.trim(), /^Usage: /, args.join(' '));
    }
    // There is no option for another key.
    const keyed = cli(['verify', '--dir', out, '--version', '4.7.4', '--key', 'other.pem']);
    assert.equal(keyed.status, 1);
    assert.match(keyed.stderr, /Unknown option '--key'/);
    // A changed asset fails the check.
    await writeFile(path.join(out, 'ServerDesk-Agent-4.7.4-manifest.sig'), record.signature + '\n');
    assert.equal(cli(['verify', '--dir', out, '--version', '4.7.4']).stderr.trim(), 'ServerDesk-Agent-4.7.4-manifest.sig does not match the signed manifest.');
    await writeFile(path.join(out, 'ServerDesk-Agent-4.7.4-manifest.sig'), record.signature);
    await writeFile(path.join(out, 'ServerDesk-Agent-4.7.4-win-x64.exe'), Buffer.concat([exe, Buffer.from('x')]));
    assert.equal(cli(['verify', '--dir', out, '--version', '4.7.4']).stderr.trim(), 'ServerDesk-Agent-4.7.4-win-x64.exe does not match the signed manifest.');
    await writeFile(path.join(out, 'ServerDesk-Agent-4.7.4-win-x64.exe'), exe);
    // Another pinned key in the checkout rejects the record.
    await writeFile(path.join(directory, 'agent', 'v3', 'release-public.pem'), otherPem);
    assert.equal(cli(['verify', '--dir', out, '--version', '4.7.4']).stderr.trim(), 'The agent release signature does not match agent/v3/release-public.pem.');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('staging copies only the expected build files of the version into the checkout', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'serverdesk-agent-stage-'));
  try {
    const from = path.join(directory, 'artifact');
    const put = async (relative, content) => { await mkdir(path.dirname(path.join(from, relative)), { recursive: true }); await writeFile(path.join(from, relative), content); };
    const expected = {
      '.build/agent-v3-artifact.json': JSON.stringify({ version: '4.7.4' }),
      '.build/ServerDesk-Agent-4.7.4-win-x64.zip': 'zip',
      '.build/agent-v3-publish/ServerDesk.Agent.exe': 'exe',
    };
    const fresh = async () => { await rm(from, { recursive: true, force: true }); for (const [relative, content] of Object.entries(expected)) await put(relative, content); };

    await fresh();
    const ok = path.join(directory, 'ok');
    await mkdir(ok);
    assert.deepEqual([...stageAgentBuild({ from, to: ok, version: '4.7.4' })].sort(), Object.keys(expected).sort());
    for (const [relative, content] of Object.entries(expected)) assert.equal(await readFile(path.join(ok, relative), 'utf8'), content);
    assert.deepEqual(buildDigests(ok, '4.7.4'), [
      { name: 'ServerDesk-Agent-4.7.4-win-x64.zip', size: 3, sha256: hash('zip') },
      { name: 'ServerDesk-Agent-4.7.4-win-x64.exe', size: 3, sha256: hash('exe') },
    ]);

    let attempt = 0;
    for (const [relative, message] of [
      ['scripts/sign-agent-release.mjs', 'The build artifact has an unexpected entry: scripts.'],
      ['agent/v3/release-public.pem', 'The build artifact has an unexpected entry: agent.'],
      ['.build/release-changelog.mjs', 'The build artifact has an unexpected entry: .build/release-changelog.mjs.'],
      // The build writes no part files: nothing below public/ belongs into the artifact.
      ['public/downloads/ServerDesk-Agent-4.7.4-win-x64.zip.part1', 'The build artifact has an unexpected entry: public.'],
      ['public/Bootstrap-ServerDesk-V3.ps1', 'The build artifact has an unexpected entry: public.'],
      ['.build/agent-v3-release.json', 'The build artifact has an unexpected entry: .build/agent-v3-release.json.'],
      ['.build/agent-v3-publish/extra/x', 'The build artifact has an unexpected entry: .build/agent-v3-publish/extra.'],
    ]) {
      await fresh();
      await put(relative, 'console.log(1)');
      const to = path.join(directory, `refused-${attempt++}`);
      await mkdir(to);
      assert.throws(() => stageAgentBuild({ from, to, version: '4.7.4' }), { message }, relative);
      assert.deepEqual(await readdir(to), [], 'nothing copied after a refusal');
    }
    await fresh();
    await rm(path.join(from, '.build', 'agent-v3-publish', 'ServerDesk.Agent.exe'));
    assert.throws(() => stageAgentBuild({ from, to: directory, version: '4.7.4' }), { message: 'The build artifact has no .build/agent-v3-publish/ServerDesk.Agent.exe.' });
    await fresh();
    await put('.build/agent-v3-artifact.json', JSON.stringify({ version: '4.7.5' }));
    assert.throws(() => stageAgentBuild({ from, to: directory, version: '4.7.4' }), { message: 'The build artifact has version 4.7.5, not 4.7.4.' });
    assert.throws(() => stageAgentBuild({ from, to: directory, version: '4.7' }), { message: 'Agent version "4.7" must be X.Y.Z or X.Y.Z-dev.<sha7>.' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the stage and digests CLIs copy into the current directory and write the hashes to the job summary', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'serverdesk-agent-stage-cli-'));
  try {
    const from = path.join(directory, 'artifact');
    const checkout = path.join(directory, 'checkout');
    await mkdir(path.join(from, '.build', 'agent-v3-publish'), { recursive: true });
    await mkdir(checkout);
    await writeFile(path.join(from, '.build', 'agent-v3-artifact.json'), JSON.stringify({ version: '4.7.4' }));
    await writeFile(path.join(from, '.build', 'ServerDesk-Agent-4.7.4-win-x64.zip'), 'zip');
    await writeFile(path.join(from, '.build', 'agent-v3-publish', 'ServerDesk.Agent.exe'), 'exe');
    const summary = path.join(directory, 'summary.md');
    const cli = args => spawnSync(process.execPath, [script, ...args], { cwd: checkout, encoding: 'utf8', env: childEnv({ GITHUB_STEP_SUMMARY: summary }) });
    const staged = cli(['stage', '--dir', from, '--version', '4.7.4']);
    assert.equal(staged.status, 0, staged.stderr);
    assert.ok(existsSync(path.join(checkout, '.build', 'agent-v3-publish', 'ServerDesk.Agent.exe')));
    assert.match(staged.stdout, new RegExp(`ServerDesk-Agent-4\\.7\\.4-win-x64\\.exe: 3 bytes, SHA-256 ${hash('exe')}`));
    const shown = cli(['digests', '--version', '4.7.4']);
    assert.equal(shown.status, 0, shown.stderr);
    const text = await readFile(summary, 'utf8');
    assert.match(text, /^### Agent 4\.7\.4 build to sign$/m);
    assert.match(text, /^### Agent 4\.7\.4 build$/m);
    assert.ok(text.includes(`| ServerDesk-Agent-4.7.4-win-x64.zip | 3 | \`${hash('zip')}\` |`), text);
    for (const args of [['stage', '--dir', from], ['digests'], ['digests', '--version', '4.7']]) assert.equal(cli(args).status, 1, args.join(' '));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('staging refuses a link in the build artifact', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'serverdesk-agent-link-'));
  try {
    const from = path.join(directory, 'artifact');
    await mkdir(path.join(from, '.build'), { recursive: true });
    await writeFile(path.join(directory, 'target.json'), JSON.stringify({ version: '4.7.4' }));
    try { symlinkSync(path.join(directory, 'target.json'), path.join(from, '.build', 'agent-v3-artifact.json'), 'file'); } catch (error) {
      if (error?.code === 'EPERM') { t.skip('creating links needs more rights here'); return; }
      throw error;
    }
    assert.throws(() => stageAgentBuild({ from, to: path.join(directory, 'to'), version: '4.7.4' }), { message: 'The build artifact has a link: .build/agent-v3-artifact.json.' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

const workflowText = await readFile(path.join(repository, '.github', 'workflows', 'agent-release.yml'), 'utf8');
const workflow = yaml.load(workflowText);
const jobs = workflow.jobs ?? {};
const steps = job => jobs[job].steps;
const runs = job => steps(job).map(step => step.run ?? '').join('\n');
const releaseIf = "needs.plan.outputs.release == 'true' && (github.ref == 'refs/heads/main' || github.ref == 'refs/heads/dev')";

test('the agent workflow runs only by hand, with read access, in one concurrency group', () => {
  assert.equal(workflow.name, 'Agent release');
  // js-yaml reads the key "on" as written.
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.equal(workflow.on.workflow_dispatch, null, 'no inputs');
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(workflow.concurrency, { group: 'agent-release', 'cancel-in-progress': false });
  assert.deepEqual(Object.keys(jobs), ['plan', 'build', 'sign', 'release']);
});

test('the agent workflow pins each action to a commit and stores no checkout credentials', () => {
  const all = Object.values(jobs).flatMap(job => job.steps);
  const used = all.filter(step => step.uses);
  assert.ok(used.length > 0);
  for (const step of used) assert.match(step.uses, /^[a-z0-9-]+\/[a-z0-9-]+@[0-9a-f]{40}$/, step.uses);
  // Each pin has the version as a comment.
  for (const line of workflowText.split(/\r?\n/).filter(line => /^\s*(?:- )?uses:/.test(line))) assert.match(line, /@[0-9a-f]{40} # v\d+\.\d+\.\d+$/, line);
  const checkouts = used.filter(step => step.uses.startsWith('actions/checkout@'));
  assert.equal(checkouts.length, 4, 'one checkout per job');
  for (const step of checkouts) assert.equal(step.with['persist-credentials'], false);
});

test('the plan job plans with the full history and exposes the outputs', () => {
  const job = jobs.plan;
  assert.equal(job['runs-on'], 'ubuntu-latest');
  assert.equal(job.environment, undefined);
  assert.equal(job.needs, undefined);
  assert.equal(steps('plan')[0].with['fetch-depth'], 0);
  assert.equal(steps('plan')[1].with['node-version'], 22);
  const plan = steps('plan').find(step => step.id === 'plan');
  assert.equal(plan.run, 'node scripts/agent-release.mjs plan');
  assert.equal(plan['working-directory'], 'ServerDesk');
  for (const name of ['version', 'tag', 'release']) assert.equal(job.outputs[name], `\${{ steps.plan.outputs.${name} }}`);
});

test('the build job builds on Windows without any secret and uploads the build with hidden files', () => {
  const job = jobs.build;
  assert.equal(job['runs-on'], 'windows-latest');
  assert.equal(job.needs, 'plan');
  assert.equal(job.if, "needs.plan.outputs.release == 'true'");
  assert.equal(job.environment, undefined);
  assert.ok(!JSON.stringify(job).includes('secrets.'), 'no secret in the build job');
  const list = steps('build');
  assert.ok(list.some(step => step.uses?.startsWith('actions/setup-dotnet@') && step.with['dotnet-version'] === '10.x'));
  assert.ok(list.some(step => step.uses?.startsWith('actions/setup-node@') && step.with['node-version'] === 22));
  assert.match(runs('build'), /corepack prepare pnpm@11\.25\.0 --activate/);
  const index = predicate => list.findIndex(predicate);
  const install = index(step => step.run === 'pnpm install --frozen-lockfile --ignore-scripts');
  const build = index(step => step.run === 'node scripts/build-agent-v3.mjs');
  const versionCheck = index(step => /agent-v3-artifact\.json/.test(step.run ?? ''));
  const upload = index(step => step.uses?.startsWith('actions/upload-artifact@'));
  const digests = index(step => step.run === 'node scripts/agent-release.mjs digests --version "$VERSION"');
  assert.ok(install >= 0 && install < build && build < versionCheck && versionCheck < digests && digests < upload);
  assert.deepEqual(list[digests].env, { VERSION: '${{ needs.plan.outputs.version }}' });
  assert.equal(list[build].env.SERVERDESK_AGENT_SMOKE_MODE, 'native');
  // The hosted Windows runner is elevated: a skipped service lifecycle self-test fails the build.
  assert.equal(list[build].env.SERVERDESK_AGENT_LIFECYCLE_TEST, 'required');
  assert.deepEqual(list[versionCheck].env, { VERSION: '${{ needs.plan.outputs.version }}' });
  const artifact = list[upload].with;
  assert.equal(artifact.name, 'agent-build');
  assert.equal(artifact['include-hidden-files'], true);
  assert.deepEqual(artifact.path.trim().split('\n').map(line => line.trim()), [
    'ServerDesk/.build/agent-v3-artifact.json',
    'ServerDesk/.build/ServerDesk-Agent-${{ needs.plan.outputs.version }}-win-x64.zip',
    'ServerDesk/.build/agent-v3-publish/ServerDesk.Agent.exe',
  ]);
});

test('the sign job is the only place of the key: one step, a private temporary file and no install', () => {
  const job = jobs.sign;
  assert.equal(job['runs-on'], 'ubuntu-latest');
  assert.deepEqual(job.needs, ['plan', 'build']);
  assert.equal(job.if, releaseIf);
  assert.equal(job.environment, 'agent-signing');
  assert.deepEqual(job.permissions, { contents: 'read' });
  const list = steps('sign');
  for (const step of list) assert.doesNotMatch(step.run ?? '', /\b(?:pnpm|npm|npx|yarn|dotnet)\b/, step.name);
  // The build artifact comes from third-party code: never into the checkout; only the expected files are copied.
  const download = list.find(step => step.uses?.startsWith('actions/download-artifact@'));
  assert.deepEqual(download.with, { name: 'agent-build', path: '${{ runner.temp }}/agent-build' });
  assert.ok(download.with.path.startsWith('${{ runner.temp }}/'), 'no download into the workspace');
  const stage = list.findIndex(step => step.run === 'node scripts/agent-release.mjs stage --dir "$RUNNER_TEMP/agent-build" --version "$VERSION"');
  assert.ok(list.indexOf(download) < stage, 'stage after the download');
  assert.equal(list[stage]['working-directory'], 'ServerDesk');
  assert.deepEqual(list[stage].env, { VERSION: '${{ needs.plan.outputs.version }}' });
  const keyed = list.filter(step => JSON.stringify(step).includes('secrets.'));
  assert.equal(keyed.length, 1, 'exactly one step with a secret');
  const [signing] = keyed;
  assert.deepEqual(signing.env, { RELEASE_KEY: '${{ secrets.AGENT_RELEASE_SIGNING_KEY }}' });
  const script = signing.run;
  assert.match(script, /if \[ -z "\$RELEASE_KEY" \]; then[\s\S]*?exit 1/);
  assert.match(script, /^umask 077$/m);
  assert.match(script, /KEY_FILE="\$RUNNER_TEMP\//);
  assert.match(script, /trap 'rm -f "\$KEY_FILE"' EXIT/);
  assert.match(script, /SERVERDESK_RELEASE_KEY_FILE="\$KEY_FILE" node scripts\/sign-agent-release\.mjs/);
  // The private file exists only after umask and trap.
  assert.ok(script.indexOf('umask 077') < script.indexOf('> "$KEY_FILE"') && script.indexOf('trap ') < script.indexOf('> "$KEY_FILE"'));
  assert.doesNotMatch(script, /set -x|set -o xtrace|echo "?\$\{?RELEASE_KEY/);
  const signIndex = list.indexOf(signing);
  assert.equal(stage, signIndex - 1, 'the expected files are in place right before the signing step');
  const assets = list[signIndex + 1];
  assert.equal(assets.run, 'node scripts/agent-release.mjs assets --out "$RUNNER_TEMP/agent-release" --version "$VERSION"');
  assert.equal(assets.env.VERSION, '${{ needs.plan.outputs.version }}');
  const upload = list[signIndex + 2];
  assert.ok(upload.uses.startsWith('actions/upload-artifact@'));
  assert.equal(upload.with.name, 'agent-release');
  assert.equal(upload.with.path, '${{ runner.temp }}/agent-release');
});

test('the verify CLI of the release job refuses an absolute-form record before anything goes to GitHub', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'serverdesk-agent-absolute-'));
  try {
    const { record, zip, exe } = signed({ mutate: manifest => toUrls(manifest) });
    await mkdir(path.join(directory, 'agent', 'v3'), { recursive: true });
    await writeFile(path.join(directory, 'agent', 'v3', 'release-public.pem'), publicKeyPem);
    const out = path.join(directory, 'out');
    await mkdir(out);
    for (const asset of agentReleaseAssets(record)) await writeFile(path.join(out, asset.name), asset.content);
    await writeFile(path.join(out, 'ServerDesk-Agent-4.7.4-win-x64.zip'), zip);
    await writeFile(path.join(out, 'ServerDesk-Agent-4.7.4-win-x64.exe'), exe);
    await writeFile(path.join(out, 'notes.md'), agentReleaseNotes(record) + '\n');
    const result = spawnSync(process.execPath, [script, 'verify', '--dir', out, '--version', '4.7.4'], { cwd: directory, encoding: 'utf8', env: childEnv() });
    assert.equal(result.status, 1);
    assert.equal(result.stderr.trim(), absoluteMessage);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the release job verifies first, tags through the refs API and publishes a draft that is not Latest', () => {
  const job = jobs.release;
  assert.equal(job['runs-on'], 'ubuntu-latest');
  assert.deepEqual(job.needs, ['plan', 'sign']);
  assert.equal(job.if, releaseIf);
  assert.deepEqual(job.permissions, { contents: 'write' });
  assert.equal(job.environment, undefined);
  assert.equal(job.env.GH_TOKEN, '${{ github.token }}');
  assert.equal(job.env.SHA, '${{ github.sha }}');
  assert.equal(job.env.TAG, '${{ needs.plan.outputs.tag }}');
  assert.equal(job.env.VERSION, '${{ needs.plan.outputs.version }}');
  const list = steps('release');
  const index = predicate => list.findIndex(predicate);
  const download = index(step => step.uses?.startsWith('actions/download-artifact@'));
  // --check-notes: the release job checks the notes.md that its own assets step wrote.
  const verify = index(step => step.run === 'node scripts/agent-release.mjs verify --dir "$RUNNER_TEMP/agent-release" --version "$VERSION" --check-notes');
  const tag = index(step => /git\/refs/.test(step.run ?? ''));
  const release = index(step => /gh release create/.test(step.run ?? ''));
  assert.ok(download >= 0 && download < verify && verify < tag && tag < release, 'verify before anything on GitHub');
  assert.ok(list.slice(0, verify).every(step => !/\bgh\b/.test(step.run ?? '')));
  assert.equal(list[verify]['working-directory'], 'ServerDesk');
  const createTag = list[tag].run;
  assert.match(createTag, /gh api --method POST "repos\/\$GH_REPO\/git\/refs" -f "ref=refs\/tags\/\$TAG" -f "sha=\$SHA"/);
  assert.match(createTag, /gh api "repos\/\$GH_REPO\/git\/ref\/tags\/\$TAG"/);
  assert.match(createTag, /if \[ "\$existing" != "\$SHA" \]; then[\s\S]*exit 1/);
  const publish = list[release].run;
  assert.match(publish, /gh release create "\$TAG" "\$@" --verify-tag --draft --latest=false --title "Agent \$VERSION" --notes-file notes\.md/);
  assert.match(publish, /gh release upload "\$TAG" "\$@" --clobber/);
  assert.match(publish, /gh release edit "\$TAG" --draft=false --latest=false/);
  assert.match(publish, /if \[ "\$draft" != "true" \]; then[\s\S]*?exit 0/, 'a published release stays as it is');
  for (const asset of ['win-x64.zip', 'win-x64.exe', 'release.json', 'manifest.json', 'manifest.sig']) assert.ok(publish.includes(`"ServerDesk-Agent-$VERSION-${asset}"`), asset);
});

test('values reach the run scripts of both workflows only through env, and only the sign step names a secret', async () => {
  const docker = yaml.load(await readFile(path.join(repository, '.github', 'workflows', 'docker-image.yml'), 'utf8'));
  for (const file of [workflow, docker]) {
    for (const step of Object.values(file.jobs).flatMap(job => job.steps)) {
      assert.doesNotMatch(step.run ?? '', /\$\{\{[^}]*\b(?:secrets|steps|needs|inputs|github\.event)\./, `no inline expression in run: ${step.name}`);
    }
  }
  for (const step of Object.values(jobs).flatMap(job => job.steps)) assert.ok(!(step.run ?? '').includes('${{'), `no expression at all in run: ${step.name}`);
  assert.equal(JSON.stringify(workflow).split('secrets.').length - 1, 1, 'secrets. only once in agent-release.yml');
});

test('the CLI and the portal import call one shared verifyAgentRelease, which names a reason for every refusal', async () => {
  const shared = await import('../../runtime/agent-release-verify.mjs');
  assert.equal(verifyAgentRelease, shared.verifyAgentRelease, 'scripts/agent-release.mjs re-exports the runtime implementation');
  assert.equal(agentReleasePartSize, shared.agentReleasePartSize);
  const script = await readFile(new URL('../../scripts/agent-release.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(script, /crypto\.verify\(|function expectedPaths/, 'no second copy of the check');
  assert.match(await readFile(new URL('../../runtime/release-import.mjs', import.meta.url), 'utf8'), /from '\.\/agent-release-verify\.mjs'/, 'the import uses the same module');
  const reason = (input, expected) => assert.throws(() => verifyAgentRelease({ publicKeyPem, version: '4.7.4', ...input }), error => error instanceof shared.AgentReleaseError && error.reason === expected, expected);
  const good = signed();
  reason({ record: good.record, publicKeyPem: otherPem }, 'signatureInvalid');
  reason({ record: { ...good.record, extra: 1 } }, 'manifestInvalid');
  reason({ record: good.record, version: '4.7.5' }, 'manifestInvalid');
  reason({ record: signed({ mutate: manifest => ({ ...manifest, path: '/downloads/agent.zip' }) }).record }, 'manifestInvalid');
  reason({ record: good.record, files: { zip: Buffer.from('other zip bytes of the agent'), exe: good.exe } }, 'hashMismatch');
});

test('build-agent-v3.mjs writes only to .build/, describes the 20 MiB parts from the bytes and refuses a version with its agent-v tag', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'serverdesk-agent-build-'));
  try {
    const version = '4.20.0';
    const put = async (relative, content) => { await mkdir(path.dirname(path.join(directory, relative)), { recursive: true }); await writeFile(path.join(directory, relative), content); };
    for (const file of ['scripts/build-agent-v3.mjs', 'runtime/agent-release-verify.mjs', 'runtime/release-manifest.mjs', 'runtime/release-version.mjs']) await put(file, await readFile(path.join(root, file)));
    await put('agent/v3/ServerDesk.Agent.csproj', csproj(version));
    try { symlinkSync(path.join(root, 'node_modules'), path.join(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir'); } catch (error) {
      if (error?.code === 'EPERM') { t.skip('creating links needs more rights here'); return; }
      throw error;
    }
    // A stand-in for dotnet: Node runs the file "publish" with the arguments of
    // dotnet publish and writes an incompressible EXE of 20 MiB and 3 bytes.
    // It also writes the managed assembly that the managed smoke on Windows runs: its --version prints the csproj
    // version with the dev suffix that the build passed as -p:ServerDeskDevSuffix.
    await put('publish', `const fs=require('fs'),path=require('path'),crypto=require('crypto');const out=process.argv[process.argv.indexOf('-o')+1];fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'ServerDesk.Agent.exe'),crypto.randomBytes(${agentReleasePartSize + 3}));const suffix=(process.argv.find(arg=>arg.startsWith('-p:ServerDeskDevSuffix='))??'').slice('-p:ServerDeskDevSuffix='.length);const dll=path.join('agent','v3','bin','Release','net10.0','win-x64','ServerDesk.Agent.dll');fs.mkdirSync(path.dirname(dll),{recursive:true});fs.writeFileSync(dll,"if(process.argv[2]==='--version')console.log('${version}'+"+JSON.stringify(suffix)+");");fs.writeFileSync(path.join('.build','publish-args.json'),JSON.stringify(process.argv.slice(2)));`);
    const git = (...args) => { const result = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd: directory, encoding: 'utf8', env: childEnv() }); assert.equal(result.status, 0, result.stderr); };
    git('init', '--quiet', '--initial-branch=main');
    git('commit', '--quiet', '--allow-empty', '-m', 'first');
    git('tag', 'agent-v4.20.1'); git('tag', 'agent-v4.2.0');
    const build = (extra = {}) => { const base = childEnv(); delete base.SERVERDESK_AGENT_VERSION; return spawnSync(process.execPath, ['scripts/build-agent-v3.mjs'], { cwd: directory, encoding: 'utf8', env: { ...base, SERVERDESK_DOTNET: process.execPath, SERVERDESK_AGENT_SMOKE_MODE: 'managed', ...extra } }); };
    // A dev build: SERVERDESK_AGENT_VERSION of the plan goes to dotnet publish as the suffix; the files carry the full version.
    const devBuilt = build({ SERVERDESK_AGENT_VERSION: `${version}-dev.abc1234` });
    assert.equal(devBuilt.status, 0, devBuilt.stderr + devBuilt.stdout);
    assert.ok(JSON.parse(await readFile(path.join(directory, '.build', 'publish-args.json'), 'utf8')).includes('-p:ServerDeskDevSuffix=-dev.abc1234'), 'the suffix reaches dotnet publish');
    const devArtifact = JSON.parse(await readFile(path.join(directory, '.build', 'agent-v3-artifact.json'), 'utf8'));
    assert.deepEqual([devArtifact.version, devArtifact.path, devArtifact.exe.path], [`${version}-dev.abc1234`, `/downloads/ServerDesk-Agent-${version}-dev.abc1234-win-x64.zip`, `/downloads/ServerDesk-Agent-${version}-dev.abc1234-win-x64.exe`]);
    assert.ok(existsSync(path.join(directory, '.build', `ServerDesk-Agent-${version}-dev.abc1234-win-x64.zip`)));
    for (const requested of ['4.20.1-dev.abc1234', '4.20.0-dev.ABC1234', '4.20.1']) {
      const refusedVersion = build({ SERVERDESK_AGENT_VERSION: requested });
      assert.equal(refusedVersion.status, 1, requested);
      assert.ok(refusedVersion.stderr.includes(`The build version "${requested}" must be ${version} or ${version}-dev.<sha7>.`), refusedVersion.stderr);
    }
    await rm(path.join(directory, '.build'), { recursive: true, force: true });
    const built = build();
    assert.equal(built.status, 0, built.stderr + built.stdout);
    assert.ok(JSON.parse(await readFile(path.join(directory, '.build', 'publish-args.json'), 'utf8')).includes('-p:ServerDeskDevSuffix='), 'a local build passes an empty suffix');
    assert.equal(existsSync(path.join(directory, 'public')), false, 'nothing is written to public/');
    const artifact = JSON.parse(await readFile(path.join(directory, '.build', 'agent-v3-artifact.json'), 'utf8'));
    const zip = await readFile(path.join(directory, '.build', `ServerDesk-Agent-${version}-win-x64.zip`)), exe = await readFile(path.join(directory, '.build', 'agent-v3-publish', 'ServerDesk.Agent.exe'));
    assert.deepEqual([artifact.size, artifact.sha256, artifact.exe.size, artifact.exe.sha256], [zip.length, hash(zip), exe.length, hash(exe)]);
    assert.deepEqual(artifact.parts, partsOf(zip, `ServerDesk-Agent-${version}-win-x64.zip`).map(({ path: entry, sha256, size }) => ({ path: entry, size, sha256 })), 'the ZIP parts are its 20 MiB slices');
    assert.deepEqual(artifact.exe.parts, partsOf(exe, `ServerDesk-Agent-${version}-win-x64.exe`).map(({ path: entry, sha256, size }) => ({ path: entry, size, sha256 })), 'the EXE parts are its 20 MiB slices');
    assert.equal(artifact.exe.parts.length, 2);
    // The tag agent-v<version> means published: refused before any file is touched.
    git('tag', `agent-v${version}`);
    await rm(path.join(directory, '.build'), { recursive: true, force: true });
    const refused = build();
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, new RegExp(`Agent ${version.replaceAll('.', '\\.')} is already published as agent-v${version.replaceAll('.', '\\.')}\\. Increase <Version> in agent/v3/ServerDesk\\.Agent\\.csproj before building\\.`));
    assert.equal(existsSync(path.join(directory, '.build')), false, 'nothing is built for a published version');
  } finally {
    // The linked node_modules goes first, so the recursive delete never reaches its target.
    await unlink(path.join(directory, 'node_modules')).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

// ---- Dev pre-releases: the dev version through the scripts, the signing, the notes and the workflow ----
const devVersion = '4.12.1-dev.abc1234';

test('stage, digests, verify and the asset names accept a dev version and refuse every other suffix', async () => {
  const good = signed({ version: devVersion });
  const manifest = verifyAgentRelease({ record: good.record, files: { zip: good.zip, exe: good.exe }, publicKeyPem, version: devVersion });
  assert.deepEqual([manifest.path, manifest.exe.path], [`/downloads/ServerDesk-Agent-${devVersion}-win-x64.zip`, `/downloads/ServerDesk-Agent-${devVersion}-win-x64.exe`]);
  assert.deepEqual(agentReleaseAssets(good.record).map(asset => asset.name), [`ServerDesk-Agent-${devVersion}-release.json`, `ServerDesk-Agent-${devVersion}-manifest.json`, `ServerDesk-Agent-${devVersion}-manifest.sig`]);
  for (const version of ['4.12.1-dev.ABC1234', '4.12.1-dev.abc123', '4.12.1-rc.1', '4.12.1-dev.abc1234.1', '04.1.0']) {
    const bad = signed({ version });
    assert.throws(() => verifyAgentRelease({ record: bad.record, publicKeyPem, version }), { message: 'The agent release record does not match its manifest.' }, version);
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'serverdesk-agent-dev-stage-'));
  try {
    const from = path.join(directory, 'artifact'), to = path.join(directory, 'checkout');
    const put = async (relative, content) => { await mkdir(path.dirname(path.join(from, relative)), { recursive: true }); await writeFile(path.join(from, relative), content); };
    await put('.build/agent-v3-artifact.json', JSON.stringify({ version: devVersion }));
    await put(`.build/ServerDesk-Agent-${devVersion}-win-x64.zip`, 'zip');
    await put('.build/agent-v3-publish/ServerDesk.Agent.exe', 'exe');
    await mkdir(to);
    assert.deepEqual(stageAgentBuild({ from, to, version: devVersion }).sort(), ['.build/ServerDesk-Agent-4.12.1-dev.abc1234-win-x64.zip', '.build/agent-v3-artifact.json', '.build/agent-v3-publish/ServerDesk.Agent.exe']);
    assert.deepEqual(buildDigests(to, devVersion).map(row => row.name), [`ServerDesk-Agent-${devVersion}-win-x64.zip`, `ServerDesk-Agent-${devVersion}-win-x64.exe`]);
    for (const version of ['4.12.1-dev.ABC1234', '4.12.1-dev.abc123', '4.12.1-rc.1']) assert.throws(() => stageAgentBuild({ from, to, version }), { message: `Agent version "${version}" must be X.Y.Z or X.Y.Z-dev.<sha7>.` });
    const digests = spawnSync(process.execPath, [script, 'digests', '--version', '4.12.1-dev.abc123'], { cwd: to, encoding: 'utf8', env: childEnv() });
    assert.equal(digests.status, 1);
    assert.equal(digests.stderr.trim(), 'Agent version "4.12.1-dev.abc123" must be X.Y.Z or X.Y.Z-dev.<sha7>.');
    const shown = spawnSync(process.execPath, [script, 'digests', '--version', devVersion], { cwd: to, encoding: 'utf8', env: childEnv() });
    assert.equal(shown.status, 0, shown.stderr);
    assert.ok(shown.stdout.includes(`ServerDesk-Agent-${devVersion}-win-x64.zip: 3 bytes`), shown.stdout);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the notes of a dev pre-release start with the dev line and select the earlier changelogs by the base', async () => {
  const { record, zip, exe } = signed({ version: devVersion, changelog: { features: ['Dev build from commit abc1234.'], fixes: [] } });
  const earlier = [{ version: '4.12.1', features: ['Not earlier: the base itself'], fixes: [] }, { version: '4.12.0', features: ['Feature of 4.12.0'], fixes: [] }, { version: '3.9.0', features: ['Other major'], fixes: [] }];
  const notes = agentReleaseNotes(record, earlier);
  assert.equal(agentDevNotesLine(devVersion), 'Dev pre-release 4.12.1-dev.abc1234 from the dev branch. Portals import it only when an owner turns on dev builds.');
  assert.ok(notes.startsWith(agentDevNotesLine(devVersion) + '\n\nWindows agent 4.12.1-dev.abc1234 (x64, protocol 3)\n\nFeatures:\n- Dev build from commit abc1234.'), notes);
  assert.ok(notes.includes('Earlier agent 4 versions, newest first.') && notes.includes('### 4.12.0') && !notes.includes('### 4.12.1') && !notes.includes('### 3.9.0'), notes);
  assert.ok(!agentReleaseNotes(signed().record).startsWith('Dev pre-release'), 'a release has no dev line');
  // assets writes the same text, and verify --check-notes computes it again.
  const directory = await mkdtemp(path.join(os.tmpdir(), 'serverdesk-agent-dev-notes-'));
  try {
    await mkdir(path.join(directory, 'agent', 'v3', 'changelogs'), { recursive: true });
    await mkdir(path.join(directory, '.build', 'agent-v3-publish'), { recursive: true });
    await writeFile(path.join(directory, 'agent', 'v3', 'release-public.pem'), publicKeyPem);
    await writeFile(path.join(directory, 'agent', 'v3', 'changelogs', '4.12.0.json'), JSON.stringify({ version: '4.12.0', features: ['Feature of 4.12.0'], fixes: [] }));
    await writeFile(path.join(directory, '.build', `ServerDesk-Agent-${devVersion}-win-x64.zip`), zip);
    await writeFile(path.join(directory, '.build', 'agent-v3-publish', 'ServerDesk.Agent.exe'), exe);
    await writeFile(path.join(directory, '.build', 'agent-v3-release.json'), JSON.stringify(record, null, 2) + '\n');
    const cli = args => spawnSync(process.execPath, [script, ...args], { cwd: directory, encoding: 'utf8', env: childEnv() });
    const out = path.join(directory, 'out');
    const collected = cli(['assets', '--out', out, '--version', devVersion]);
    assert.equal(collected.status, 0, collected.stderr);
    assert.ok((await readFile(path.join(out, 'notes.md'), 'utf8')).startsWith(agentDevNotesLine(devVersion)));
    assert.ok(existsSync(path.join(out, `ServerDesk-Agent-${devVersion}-win-x64.exe`)));
    const verified = cli(['verify', '--dir', out, '--version', devVersion, '--check-notes']);
    assert.equal(verified.status, 0, verified.stderr);
    await writeFile(path.join(out, 'notes.md'), 'Windows agent 4.12.1-dev.abc1234\n');
    const changed = cli(['verify', '--dir', out, '--version', devVersion, '--check-notes']);
    assert.equal(changed.status, 1);
    assert.equal(changed.stderr.trim(), 'notes.md does not match the signed manifest.');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('sign-agent-release.mjs signs a dev build with the changelog of its base when valid, else with one generated line', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'serverdesk-agent-dev-sign-'));
  try {
    const put = async (relative, content) => { await mkdir(path.dirname(path.join(directory, relative)), { recursive: true }); await writeFile(path.join(directory, relative), content); };
    for (const file of ['scripts/sign-agent-release.mjs', 'scripts/release-changelog.mjs', 'runtime/release-manifest.mjs', 'runtime/release-version.mjs', 'runtime/agent-release-verify.mjs']) await put(file, await readFile(path.join(root, file)));
    const zipName = `ServerDesk-Agent-${devVersion}-win-x64.zip`, exeName = `ServerDesk-Agent-${devVersion}-win-x64.exe`;
    const zip = Buffer.from('zip bytes of a dev agent'), exe = Buffer.from('exe bytes of a dev agent');
    await put(`.build/${zipName}`, zip);
    await put('.build/agent-v3-publish/ServerDesk.Agent.exe', exe);
    await put('.build/agent-v3-artifact.json', JSON.stringify({ version: devVersion, arch: 'x64', protocolVersion: 3, size: zip.length, sha256: hash(zip), path: `/downloads/${zipName}`, parts: [], layout: 'single-exe', exe: { path: `/downloads/${exeName}`, size: exe.length, sha256: hash(exe), parts: [] } }));
    await put('agent/v3/release-public.pem', publicKeyPem);
    const keyFile = path.join(directory, 'release-private.pem');
    await writeFile(keyFile, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const target = path.join(directory, '.build', 'agent-v3-release.json');
    const sign = async () => {
      await rm(target, { force: true });
      const result = spawnSync(process.execPath, ['scripts/sign-agent-release.mjs'], { cwd: directory, encoding: 'utf8', env: childEnv({ SERVERDESK_RELEASE_KEY_FILE: keyFile }) });
      assert.equal(result.status, 0, result.stderr);
      const record = JSON.parse(await readFile(target, 'utf8'));
      verifyAgentRelease({ record, files: { zip, exe }, publicKeyPem, version: devVersion });
      return JSON.parse(record.manifest).changelog;
    };
    const generated = { features: ['Dev build from commit abc1234.'], fixes: [] };
    assert.deepEqual(await sign(), generated, 'no changelog file: one generated line');
    await put('agent/v3/changelogs/4.12.1.json', JSON.stringify({ version: '4.12.1', features: ['Planned for 4.12.1'], fixes: ['A fix'] }));
    assert.deepEqual(await sign(), { features: ['Planned for 4.12.1'], fixes: ['A fix'] }, 'the valid changelog of the base');
    await put('agent/v3/changelogs/4.12.1.json', JSON.stringify({ version: '4.12.1', features: [], fixes: [] }));
    assert.deepEqual(await sign(), generated, 'an invalid changelog of the base: the generated line');
    await put('agent/v3/changelogs/4.12.1.json', '{ not json');
    assert.deepEqual(await sign(), generated, 'a file that is not JSON: the generated line');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the workflow: plan outputs prerelease, the build takes the plan version, sign and release run on main or dev, --prerelease only on the dev path', () => {
  assert.equal(jobs.plan.outputs.prerelease, '${{ steps.plan.outputs.prerelease }}');
  const build = steps('build').find(step => step.run === 'node scripts/build-agent-v3.mjs');
  assert.equal(build.env.SERVERDESK_AGENT_VERSION, '${{ needs.plan.outputs.version }}', 'the plan version through env');
  assert.equal(jobs.build.if, "needs.plan.outputs.release == 'true'");
  for (const job of ['sign', 'release']) assert.equal(jobs[job].if, "needs.plan.outputs.release == 'true' && (github.ref == 'refs/heads/main' || github.ref == 'refs/heads/dev')", job);
  assert.equal(jobs.sign.environment, 'agent-signing');
  assert.equal(jobs.release.env.PRERELEASE, '${{ needs.plan.outputs.prerelease }}');
  const publish = steps('release').find(step => /gh release create/.test(step.run ?? '')).run;
  const lines = publish.split('\n').map(line => line.trim());
  const creates = lines.filter(line => line.startsWith('gh release create'));
  assert.deepEqual(creates, [
    'gh release create "$TAG" "$@" --verify-tag --draft --prerelease --latest=false --title "Agent $VERSION" --notes-file notes.md',
    'gh release create "$TAG" "$@" --verify-tag --draft --latest=false --title "Agent $VERSION" --notes-file notes.md',
  ], 'the main line is unchanged; the dev line adds --prerelease');
  assert.ok(lines.indexOf('elif [ "$PRERELEASE" = "true" ]; then') === lines.indexOf(creates[0]) - 1, '--prerelease only on the dev path');
  assert.deepEqual(lines.filter(line => line.startsWith('gh release edit')), ['gh release edit "$TAG" --draft=false --latest=false'], 'publishing keeps the pre-release flag and never marks Latest');
  assert.equal((publish.match(/--prerelease/g) ?? []).length, 1);
  const header = workflowText.split('\nname:')[0];
  assert.match(header, /on main it publishes the release agent-vX\.Y\.Z, on dev\n# the pre-release agent-vX\.Y\.Z-dev\.<sha7>/);
  assert.match(header, /agent-signing with the\n# owner as required reviewer and the deployment branches main and dev/);
});

test('every process this file starts gets childEnv, so no GITHUB_* variable of the runner reaches a CLI', async () => {
  const source = await readFile(new URL(import.meta.url), 'utf8');
  const calls = source.split(/\r?\n/).filter(line => line.includes('spawnSync(') && !line.startsWith('import ') && !line.includes("line.includes('spawnSync(')"));
  assert.ok(calls.length >= 10, `found ${calls.length} spawnSync calls`);
  // Either childEnv directly, or a base from childEnv on the same line that drops one more variable.
  for (const line of calls) assert.ok(/env: childEnv\(/.test(line) || (/env: \{ \.\.\.base, /.test(line) && line.includes('const base = childEnv();')), line.trim());
  const env = childEnv({ GITHUB_OUTPUT: 'set by the case' });
  assert.equal(env.GITHUB_OUTPUT, 'set by the case');
  assert.deepEqual(Object.keys(env).filter(name => name.toUpperCase().startsWith('GITHUB_')), ['GITHUB_OUTPUT']);
});
