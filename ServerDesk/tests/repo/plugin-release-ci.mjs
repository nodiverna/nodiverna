// Plugin releases from the CI (.github/workflows/plugin-release.yml): the plan,
// the assets and notes, the assets and verify CLIs (notes.md only with
// --check-notes), the copy of the build into the checkout, the project
// metadata of the DHCP and DNS plugins and the hardening of the workflow. The agent
// workflow keeps its single-EXE ZIP. The build artifact: staging takes the layout
// that upload-artifact produces (root ServerDesk/.build), checked against the
// upload, download and stage steps through tests/support/upload-artifact-layout.mjs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomUUID, sign, createHash } from 'node:crypto';
import { symlinkSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { planPluginRelease, pluginBuildDigests, pluginDevNotesLine, pluginPascalName, pluginPaths, pluginReleaseAssets, pluginReleaseNotes, stagePluginBuild } from '../../scripts/plugin-release.mjs';
import { verifyPluginRelease } from '../../runtime/plugin-release-verify.mjs';
import { pluginProjectMetadata } from '../../scripts/build-plugin.mjs';
import { validateReleaseChangelog } from '../../scripts/release-changelog.mjs';
import { pluginReleaseManifest } from '../../scripts/sign-plugin-release.mjs';
import { serverDeskRoot, repositoryRoot } from '../support/paths.mjs';
import { filesOfUploadPath, uploadArtifactLayout } from '../support/upload-artifact-layout.mjs';

const root = serverDeskRoot;
const repository = repositoryRoot;
const require = createRequire(import.meta.url);
// js-yaml is an existing ESLint dependency, not a new application dependency.
const yaml = createRequire(require.resolve('eslint/package.json'))('js-yaml');
const csproj = version => `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><Version>${version}</Version><PluginRole>dhcp</PluginRole></PropertyGroup></Project>`;
const changelog = version => ({ version, features: ['Reads the DHCP server.'], fixes: [] });
const devSha = 'abc1234def567890abcdef1234567890abcdef12';
const hashOf = bytes => createHash('sha256').update(bytes).digest('hex');

test('the plan on dev builds the pre-release plugin-<name>-vX.Y.Z-dev.<sha7> without a changelog', () => {
  const plan = extra => planPluginRelease({ csproj: csproj('1.0.1'), ref: 'refs/heads/dev', tags: [], name: 'dhcp', changelog: null, sha: devSha, ...extra });
  assert.deepEqual(plan(), { name: 'dhcp', version: '1.0.1-dev.abc1234', tag: 'plugin-dhcp-v1.0.1-dev.abc1234', release: true, prerelease: true }, 'no changelog needed');
  assert.deepEqual(plan({ tags: ['plugin-dhcp-v1.0.0', 'plugin-dns-v1.0.1'] }).release, true);
  assert.deepEqual(plan({ tags: ['plugin-dhcp-v1.0.1-dev.abc1234'] }), { name: 'dhcp', version: '1.0.1-dev.abc1234', tag: 'plugin-dhcp-v1.0.1-dev.abc1234', release: false, prerelease: true }, 'the dev tag exists');
  assert.throws(() => plan({ tags: ['plugin-dhcp-v1.0.1'] }), { message: 'Plugin dhcp 1.0.1 is already released as plugin-dhcp-v1.0.1. Increase <Version> on dev to build a dev release.' });
  assert.throws(() => planPluginRelease({ csproj: csproj('1.0.1'), ref: 'refs/heads/dev', name: 'dhcp' }), /40 hex characters/);
  for (const sha of ['', 'abc1234', devSha.slice(1), 'z'.repeat(40)]) assert.throws(() => plan({ sha }), /40 hex characters/, sha);
});

test('the notes, the assets, stage, digests and verify of a dev plugin build', async () => {
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const version = '1.0.4-dev.abc1234', exe = Buffer.from('dns plugin exe ' + version);
  const manifest = JSON.stringify({
    kind: 'plugin', name: 'dns', target: 'dns', role: 'dns', version, minAgentVersion: '4.21.2', protocolVersion: 1, os: ['Windows Server 2022'], arch: 'x64',
    capabilities: ['dns-read'], exe: { path: `/downloads/ServerDesk-Plugin-dns-${version}-win-x64.exe`, sha256: hashOf(exe), size: exe.length },
    changelog: { features: ['Dev build from commit abc1234.'], fixes: [] }, createdAt: '2026-11-20T00:00:00.000Z',
  });
  const record = { id: randomUUID(), name: 'dns', version, manifest, signature: sign('sha256', Buffer.from(manifest), keys.privateKey).toString('base64'), sha256: hashOf(exe), size: exe.length, createdAt: Date.UTC(2026, 10, 20) };
  const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' });
  assert.equal(verifyPluginRelease({ record, files: { exe }, publicKeyPem, name: 'dns', version }).version, version);
  assert.deepEqual(pluginReleaseAssets(record).map(asset => asset.name), [`ServerDesk-Plugin-dns-${version}-release.json`, `ServerDesk-Plugin-dns-${version}-manifest.json`, `ServerDesk-Plugin-dns-${version}-manifest.sig`]);
  assert.equal(pluginDevNotesLine(version), 'Dev pre-release 1.0.4-dev.abc1234 from the dev branch. Portals import it only when an owner turns on dev builds.');
  assert.ok(pluginReleaseNotes(record).startsWith(pluginDevNotesLine(version) + '\n\nPlugin dns 1.0.4-dev.abc1234 for dns (x64, plugin protocol 1). Needs agent 4.21.2 or later.'), pluginReleaseNotes(record));
  for (const bad of ['1.0.4-dev.ABC1234', '1.0.4-dev.abc123', '1.0.4-rc.1', '1.0.4-dev.abc1234.1']) {
    const other = { ...record, version: bad };
    assert.throws(() => verifyPluginRelease({ record: other, publicKeyPem, name: 'dns', version: bad }), { message: 'The plugin release record does not match its manifest.' }, bad);
  }
  // A dev minimum agent version is refused: the minimum stays X.Y.Z.
  const devMinimum = JSON.stringify({ ...JSON.parse(manifest), minAgentVersion: '4.21.2-dev.abc1234' });
  assert.throws(() => verifyPluginRelease({ record: { ...record, manifest: devMinimum, signature: sign('sha256', Buffer.from(devMinimum), keys.privateKey).toString('base64') }, publicKeyPem, name: 'dns', version }), /the minimum agent version must be X\.Y\.Z/);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sd-plugin-dev-'));
  try {
    const from = path.join(directory, 'artifact'), to = path.join(directory, 'checkout');
    await mkdir(path.join(from, 'plugin-dns-publish'), { recursive: true });
    await writeFile(path.join(from, 'plugin-dns-artifact.json'), JSON.stringify({ name: 'dns', version }));
    await writeFile(path.join(from, 'plugin-dns-publish', 'ServerDesk.Plugin.Dns.exe'), exe);
    await mkdir(to);
    assert.deepEqual(stagePluginBuild({ from, to, name: 'dns', version }).sort(), ['.build/plugin-dns-artifact.json', '.build/plugin-dns-publish/ServerDesk.Plugin.Dns.exe']);
    assert.deepEqual(pluginBuildDigests(to, 'dns', version).map(row => row.name), [`ServerDesk-Plugin-dns-${version}-win-x64.exe`]);
    assert.throws(() => stagePluginBuild({ from, to, name: 'dns', version: '1.0.4-dev.abc123' }), { message: 'Plugin version "1.0.4-dev.abc123" must be X.Y.Z or X.Y.Z-dev.<sha7>.' });
    await mkdir(path.join(to, 'agent', 'v3'), { recursive: true });
    await writeFile(path.join(to, 'agent', 'v3', 'release-public.pem'), publicKeyPem);
    await writeFile(path.join(to, '.build', 'plugin-dns-release.json'), JSON.stringify(record, null, 2) + '\n');
    const cli = args => spawnSync(process.execPath, [path.join(root, 'scripts', 'plugin-release.mjs'), ...args], { cwd: to, encoding: 'utf8' });
    const out = path.join(directory, 'out');
    const collected = cli(['assets', '--plugin', 'dns', '--out', out, '--version', version]);
    assert.equal(collected.status, 0, collected.stderr);
    assert.ok((await readFile(path.join(out, 'notes.md'), 'utf8')).startsWith(pluginDevNotesLine(version)));
    const verified = cli(['verify', '--plugin', 'dns', '--dir', out, '--version', version, '--check-notes']);
    assert.equal(verified.status, 0, verified.stderr);
    const refused = cli(['digests', '--plugin', 'dns', '--version', '1.0.4-rc.1']);
    assert.deepEqual([refused.status, refused.stderr.trim()], [1, 'Plugin version "1.0.4-rc.1" must be X.Y.Z or X.Y.Z-dev.<sha7>.']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('sign-plugin-release.mjs signs a dev build with the changelog of its base when valid, else with one generated line', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sd-plugin-dev-sign-'));
  try {
    const put = async (relative, content) => { await mkdir(path.dirname(path.join(directory, relative)), { recursive: true }); await writeFile(path.join(directory, relative), content); };
    for (const file of ['scripts/sign-plugin-release.mjs', 'scripts/plugin-release.mjs', 'scripts/release-changelog.mjs', 'runtime/plugin-release-verify.mjs', 'runtime/release-version.mjs']) await put(file, await readFile(path.join(root, file)));
    const version = '1.0.4-dev.abc1234', exe = Buffer.from('dns plugin exe ' + version);
    await put('.build/plugin-dns-publish/ServerDesk.Plugin.Dns.exe', exe);
    await put('.build/plugin-dns-artifact.json', JSON.stringify({ name: 'dns', version, target: 'dns', minAgentVersion: '4.21.2', capabilities: ['dns-read'], os: ['Windows Server 2022'], arch: 'x64', exe: { path: `/downloads/ServerDesk-Plugin-dns-${version}-win-x64.exe`, sha256: hashOf(exe), size: exe.length } }));
    const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    await put('agent/v3/release-public.pem', keys.publicKey.export({ type: 'spki', format: 'pem' }));
    const keyFile = path.join(directory, 'key.pem');
    await writeFile(keyFile, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const sign = async () => {
      await rm(path.join(directory, '.build', 'plugin-dns-release.json'), { force: true });
      const result = spawnSync(process.execPath, ['scripts/sign-plugin-release.mjs', '--plugin', 'dns'], { cwd: directory, encoding: 'utf8', env: { ...process.env, SERVERDESK_RELEASE_KEY_FILE: keyFile } });
      assert.equal(result.status, 0, result.stderr);
      const record = JSON.parse(await readFile(path.join(directory, '.build', 'plugin-dns-release.json'), 'utf8'));
      assert.equal(record.version, version);
      return JSON.parse(record.manifest).changelog;
    };
    const generated = { features: ['Dev build from commit abc1234.'], fixes: [] };
    assert.deepEqual(await sign(), generated, 'no changelog file');
    await put('agent/plugins/dns/changelogs/1.0.4.json', JSON.stringify({ version: '1.0.4', features: [], fixes: ['Planned fix'] }));
    assert.deepEqual(await sign(), { features: [], fixes: ['Planned fix'] }, 'the valid changelog of the base');
    await put('agent/plugins/dns/changelogs/1.0.4.json', JSON.stringify({ version: '1.0.5', features: ['Wrong version'], fixes: [] }));
    assert.deepEqual(await sign(), generated, 'a changelog that is not valid for the base');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the plan reads the version from the project file, runs only on main or dev and stops at an existing tag', () => {
  const plan = extra => planPluginRelease({ csproj: csproj('1.0.0'), ref: 'refs/heads/main', tags: [], name: 'dhcp', changelog: changelog('1.0.0'), ...extra });
  assert.deepEqual(plan(), { name: 'dhcp', version: '1.0.0', tag: 'plugin-dhcp-v1.0.0', release: true, prerelease: false });
  assert.deepEqual(plan({ tags: ['plugin-dhcp-v1.0.0'], changelog: null }), { name: 'dhcp', version: '1.0.0', tag: 'plugin-dhcp-v1.0.0', release: false, prerelease: false }, 'an existing tag ends the run, a changelog is not needed then');
  assert.equal(plan({ tags: ['plugin-dhcp-v1.0.00', 'agent-v1.0.0', 'plugin-dns-v1.0.0'] }).release, true, 'only the exact tag counts');
  for (const ref of ['refs/heads/feature', 'refs/tags/plugin-dhcp-v1.0.0', 'dev', '']) assert.throws(() => plan({ ref, sha: devSha }), { message: `Plugin releases run only from main or dev (got ${ref}).` });
  assert.throws(() => plan({ changelog: null }), /Add agent\/plugins\/dhcp\/changelogs\/1\.0\.0\.json/);
  assert.throws(() => plan({ changelog: changelog('1.0.1') }), /version 1\.0\.0/);
  assert.throws(() => plan({ csproj: '<Project/>' }), /version missing/);
  assert.throws(() => plan({ csproj: csproj('1.0') }), /must be X\.Y\.Z/);
  assert.throws(() => plan({ name: 'DHCP' }), /not valid/);
  assert.deepEqual([pluginPascalName('dhcp'), pluginPascalName('file-server')], ['Dhcp', 'FileServer']);
  assert.equal(pluginPaths('dhcp').project, 'agent/plugins/dhcp/ServerDesk.Plugin.Dhcp.csproj');
});

test('the assets are the record, the exact manifest bytes and the signature; the notes come from the signed changelog', () => {
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const manifest = JSON.stringify({ kind: 'plugin', name: 'dhcp', role: 'dhcp', version: '1.0.0', minAgentVersion: '4.16.0', protocolVersion: 1, arch: 'x64', changelog: { features: ['Reads the DHCP server.'], fixes: ['None yet.'] } });
  const record = { id: randomUUID(), name: 'dhcp', version: '1.0.0', manifest, signature: sign('sha256', Buffer.from(manifest), keys.privateKey).toString('base64'), sha256: 'a'.repeat(64), size: 10, createdAt: 1 };
  const assets = pluginReleaseAssets(record);
  assert.deepEqual(assets.map(asset => asset.name), ['ServerDesk-Plugin-dhcp-1.0.0-release.json', 'ServerDesk-Plugin-dhcp-1.0.0-manifest.json', 'ServerDesk-Plugin-dhcp-1.0.0-manifest.sig']);
  assert.equal(assets[1].content, manifest, 'the exact signed bytes');
  assert.equal(assets[2].content, record.signature);
  assert.deepEqual(JSON.parse(assets[0].content), record);
  const notes = pluginReleaseNotes(record);
  assert.match(notes, /^Plugin dhcp 1\.0\.0 for dhcp \(x64, plugin protocol 1\)\. Needs agent 4\.16\.0 or later\./, 'a role-only manifest names its role');
  const targeted = JSON.stringify({ ...JSON.parse(manifest), target: 'dhcp' });
  assert.match(pluginReleaseNotes({ ...record, manifest: targeted }), /^Plugin dhcp 1\.0\.0 for dhcp \(x64, plugin protocol 1\)\./, 'a manifest with target names its target');
  assert.match(pluginReleaseNotes({ ...record, manifest: JSON.stringify({ ...JSON.parse(manifest), target: 'dns' }) }), /^Plugin dhcp 1\.0\.0 for dns /, 'target wins over role');
  assert.match(notes, /Features:\n- Reads the DHCP server\./);
  assert.match(notes, /Fixes:\n- None yet\./);
  assert.match(notes, /ServerDesk\/agent\/v3\/release-public\.pem/);
});

test('the assets and verify CLIs check the signed files; verify compares the unsigned notes.md only with --check-notes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sd-plugin-assets-'));
  try {
    // A signed DNS record with target, built like tests/lib/plugin-release-verify.mjs, and the pinned key of the checkout.
    const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const exe = Buffer.from('dns plugin exe 1.0.2'), hash = bytes => createHash('sha256').update(bytes).digest('hex');
    const manifest = JSON.stringify({
      kind: 'plugin', name: 'dns', target: 'dns', role: 'dns', version: '1.0.2', minAgentVersion: '4.21.2', protocolVersion: 1, os: ['Windows Server 2022', 'Windows Server 2025'], arch: 'x64',
      capabilities: ['dns-read'], exe: { path: '/downloads/ServerDesk-Plugin-dns-1.0.2-win-x64.exe', sha256: hash(exe), size: exe.length },
      changelog: { features: [], fixes: ['Release manifest carries the detection target.'] }, createdAt: '2026-11-14T00:00:00.000Z',
    });
    const record = { id: randomUUID(), name: 'dns', version: '1.0.2', manifest, signature: sign('sha256', Buffer.from(manifest), keys.privateKey).toString('base64'), sha256: hash(exe), size: exe.length, createdAt: Date.UTC(2026, 10, 14) };
    await mkdir(path.join(directory, 'agent', 'v3'), { recursive: true });
    await writeFile(path.join(directory, 'agent', 'v3', 'release-public.pem'), keys.publicKey.export({ type: 'spki', format: 'pem' }));
    await mkdir(path.join(directory, '.build', 'plugin-dns-publish'), { recursive: true });
    await writeFile(path.join(directory, '.build', 'plugin-dns-publish', 'ServerDesk.Plugin.Dns.exe'), exe);
    await writeFile(path.join(directory, '.build', 'plugin-dns-release.json'), JSON.stringify(record, null, 2) + '\n');
    const script = path.join(root, 'scripts', 'plugin-release.mjs');
    const cli = args => spawnSync(process.execPath, [script, ...args], { cwd: directory, encoding: 'utf8' });
    const out = path.join(directory, 'out');
    const base = ['--plugin', 'dns', '--dir', out, '--version', '1.0.2'];

    const collected = cli(['assets', '--plugin', 'dns', '--out', out, '--version', '1.0.2']);
    assert.equal(collected.status, 0, collected.stderr);
    const notes = await readFile(path.join(out, 'notes.md'), 'utf8');
    assert.equal(notes, pluginReleaseNotes(record) + '\n');
    assert.match(notes, /^Plugin dns 1\.0\.2 for dns \(x64/);
    const verified = cli(['verify', ...base]);
    assert.equal(verified.status, 0, verified.stderr);
    assert.equal(verified.stdout.trim(), 'Plugin dns 1.0.2: the release assets match the signature of agent/v3/release-public.pem.');
    const checked = cli(['verify', ...base, '--check-notes']);
    assert.equal(checked.status, 0, checked.stderr);

    // notes.md is unsigned: verify alone ignores it, --check-notes compares it.
    const notesDiffer = label => {
      const plain = cli(['verify', ...base]);
      assert.equal(plain.status, 0, `${label}: ${plain.stderr}`);
      const strict = cli(['verify', ...base, '--check-notes']);
      assert.equal(strict.status, 1, label);
      assert.equal(strict.stderr.trim(), 'notes.md does not match the signed manifest.', label);
    };
    // The wording before the manifest carried target (a cached NAS release folder).
    const roleWording = notes.replace('Plugin dns 1.0.2 for dns ', 'Plugin dns 1.0.2 for the server role dns ');
    assert.notEqual(roleWording, notes);
    await writeFile(path.join(out, 'notes.md'), roleWording);
    notesDiffer('role wording');
    await rm(path.join(out, 'notes.md'));
    notesDiffer('missing notes.md');
    await writeFile(path.join(out, 'notes.md'), notes);

    // Without the option, every signed file is still checked.
    const fails = async (file, content, message) => {
      const original = await readFile(path.join(out, file));
      await writeFile(path.join(out, file), content);
      const result = cli(['verify', ...base]);
      assert.equal(result.status, 1, file);
      assert.equal(result.stderr.trim(), message, file);
      await writeFile(path.join(out, file), original);
    };
    await fails('ServerDesk-Plugin-dns-1.0.2-manifest.sig', record.signature + '\n', 'ServerDesk-Plugin-dns-1.0.2-manifest.sig does not match the signed manifest.');
    await fails('ServerDesk-Plugin-dns-1.0.2-manifest.json', manifest + '\n', 'ServerDesk-Plugin-dns-1.0.2-manifest.json does not match the signed manifest.');
    await fails('ServerDesk-Plugin-dns-1.0.2-win-x64.exe', Buffer.concat([exe, Buffer.from('x')]), 'ServerDesk-Plugin-dns-1.0.2-win-x64.exe does not match the signed manifest.');
    await fails('ServerDesk-Plugin-dns-1.0.2-release.json', JSON.stringify({ ...record, version: '1.0.3' }, null, 2) + '\n', 'The plugin release record is dns 1.0.3, not dns 1.0.2.');
    for (const [args, message] of [
      [['--plugin', 'dns', '--dir', out, '--version', '1.0.3'], 'ServerDesk-Plugin-dns-1.0.3-release.json is missing or not valid JSON.'],
      [['--plugin', 'dhcp', '--dir', out, '--version', '1.0.2'], 'ServerDesk-Plugin-dhcp-1.0.2-release.json is missing or not valid JSON.'],
    ]) {
      const result = cli(['verify', ...args]);
      assert.deepEqual([result.status, result.stderr.trim()], [1, message]);
    }
    await writeFile(path.join(directory, 'agent', 'v3', 'release-public.pem'), generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ type: 'spki', format: 'pem' }));
    assert.equal(cli(['verify', ...base]).stderr.trim(), 'The plugin release signature does not match agent/v3/release-public.pem.');

    // --check-notes belongs to verify only.
    for (const args of [['assets', '--plugin', 'dns', '--out', out, '--version', '1.0.2'], ['plan', '--plugin', 'dns'], ['digests', '--plugin', 'dns', '--version', '1.0.2'], ['stage', '--plugin', 'dns', '--dir', out, '--version', '1.0.2']]) {
      const result = cli([...args, '--check-notes']);
      assert.equal(result.status, 1, args[0]);
      assert.match(result.stderr.trim(), /^Usage: node scripts\/plugin-release\.mjs .*verify --plugin <name> --dir <dir> --version X\.Y\.Z \[--check-notes\]$/, args[0]);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// The artifact root is ServerDesk/.build of the build job (upload-artifact stores the
// files relative to the common folder of the upload paths): the fixtures hold the
// entries without a .build/ prefix, as the sign job downloads them.
test('stage copies only the artifact metadata and the published EXE into .build/ and refuses anything else', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sd-plugin-stage-'));
  try {
    const from = path.join(directory, 'artifact');
    const put = async (relative, content) => { await mkdir(path.dirname(path.join(from, relative)), { recursive: true }); await writeFile(path.join(from, relative), content); };
    const expected = { 'plugin-dhcp-artifact.json': JSON.stringify({ name: 'dhcp', version: '1.0.0' }), 'plugin-dhcp-publish/ServerDesk.Plugin.Dhcp.exe': 'exe' };
    const fresh = async () => { await rm(from, { recursive: true, force: true }); for (const [relative, content] of Object.entries(expected)) await put(relative, content); };
    await fresh();
    const ok = path.join(directory, 'ok');
    await mkdir(ok);
    assert.deepEqual(stagePluginBuild({ from, to: ok, name: 'dhcp', version: '1.0.0' }), ['.build/plugin-dhcp-artifact.json', '.build/plugin-dhcp-publish/ServerDesk.Plugin.Dhcp.exe']);
    for (const [relative, content] of Object.entries(expected)) assert.equal(await readFile(path.join(ok, '.build', relative), 'utf8'), content);
    assert.deepEqual(await readdir(ok), ['.build'], 'nothing outside .build/ of the checkout');
    assert.deepEqual(pluginBuildDigests(ok, 'dhcp', '1.0.0'), [{ name: 'ServerDesk-Plugin-dhcp-1.0.0-win-x64.exe', size: 3, sha256: hashOf('exe') }]);
    assert.deepEqual([pluginPaths('dhcp').artifact, pluginPaths('dhcp').publish], ['.build/plugin-dhcp-artifact.json', '.build/plugin-dhcp-publish'], 'pluginPaths keeps the paths of the checkout');

    let attempt = 0;
    const refused = async (message, label, input = {}) => {
      const to = path.join(directory, `refused-${attempt++}`);
      await mkdir(to);
      assert.throws(() => stagePluginBuild({ from, to, name: 'dhcp', version: '1.0.0', ...input }), { message }, label);
      assert.deepEqual(await readdir(to), [], `nothing copied after a refusal: ${label}`);
    };
    await refused('The build artifact is dhcp 1.0.0, not dhcp 1.0.1.', 'another version', { version: '1.0.1' });
    for (const [relative, message] of [
      ['scripts.mjs', 'The build artifact has an unexpected entry: scripts.mjs.'],
      ['scripts/plugin-release.mjs', 'The build artifact has an unexpected entry: scripts.'],
      ['agent/v3/release-public.pem', 'The build artifact has an unexpected entry: agent.'],
      ['plugin-dhcp-release.json', 'The build artifact has an unexpected entry: plugin-dhcp-release.json.'],
      ['plugin-dhcp-publish/ServerDesk.Plugin.Dhcp.pdb', 'The build artifact has an unexpected entry: plugin-dhcp-publish/ServerDesk.Plugin.Dhcp.pdb.'],
      ['plugin-dhcp-publish/other.exe', 'The build artifact has an unexpected entry: plugin-dhcp-publish/other.exe.'],
      ['plugin-dns-publish/ServerDesk.Plugin.Dns.exe', 'The build artifact has an unexpected entry: plugin-dns-publish.'],
    ]) {
      await fresh();
      await put(relative, 'evil');
      await refused(message, relative);
    }
    // The layout this script assumed before: the files below a .build folder of the artifact.
    await rm(from, { recursive: true, force: true });
    for (const [relative, content] of Object.entries(expected)) await put(`.build/${relative}`, content);
    await refused('The build artifact has an unexpected entry: .build.', 'a root .build folder');
    await fresh();
    await rm(path.join(from, 'plugin-dhcp-publish', 'ServerDesk.Plugin.Dhcp.exe'));
    await refused('The build artifact has no plugin-dhcp-publish/ServerDesk.Plugin.Dhcp.exe.', 'a missing EXE');
    await fresh();
    await put('plugin-dhcp-artifact.json', '{ not json');
    await refused('plugin-dhcp-artifact.json in the build artifact is not valid JSON.', 'metadata that is not JSON');
    await fresh();
    await put('plugin-dhcp-artifact.json', JSON.stringify({ name: 'dns', version: '1.0.0' }));
    await refused('The build artifact is dns 1.0.0, not dhcp 1.0.0.', 'metadata of another plugin');
    // The artifact of another plugin: its files are unexpected for dhcp.
    await rm(from, { recursive: true, force: true });
    await put('plugin-dns-artifact.json', JSON.stringify({ name: 'dns', version: '1.0.0' }));
    await refused('The build artifact has an unexpected entry: plugin-dns-artifact.json.', 'the artifact of dns');
    await fresh();
    await rm(path.join(from, 'plugin-dhcp-artifact.json'));
    try { symlinkSync(path.join(directory, 'ok', '.build', 'plugin-dhcp-artifact.json'), path.join(from, 'plugin-dhcp-artifact.json'), 'file'); } catch (error) {
      if (error?.code === 'EPERM') { t.skip('creating links needs more rights here'); return; }
      throw error;
    }
    await refused('The build artifact has a link: plugin-dhcp-artifact.json.', 'a link');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the DHCP plugin project names its version, target, minimum agent and capability, and the plugin says the same', async () => {
  const project = await readFile(path.join(root, 'agent/plugins/dhcp/ServerDesk.Plugin.Dhcp.csproj'), 'utf8'), program = await readFile(path.join(root, 'agent/plugins/dhcp/Program.cs'), 'utf8');
  const agent = await readFile(path.join(root, 'agent/v3/ServerDesk.Agent.csproj'), 'utf8');
  const metadata = pluginProjectMetadata(project, 'dhcp');
  // DHCP plugin 1.1.2 (1.1.0 added the 25 changes; 1.1.1 fixes the heap corruption on a server with scopes; 1.1.2 rewrites the result messages): the read and the 25 changes.
  const changes = await readFile(path.join(root, 'agent/plugins/dhcp/DhcpChanges.cs'), 'utf8');
  const operations = [...(/Operations =\s*\[([^\]]+)\]/.exec(changes)?.[1] ?? '').matchAll(/"([a-z0-9-]+)"/g)].map(match => match[1]);
  assert.deepEqual([metadata.version, metadata.target, metadata.capabilities], ['1.1.2', 'dhcp', ['dhcp-read', ...operations]]);
  assert.equal(Object.hasOwn(metadata, 'role'), false, 'the metadata name the target, not the role');
  assert.equal(metadata.capabilities.length, 26, 'dhcp-read and 25 changes, within the limit of 32');
  // The plugin's minimum stays when the agent moves on (4.17.0 added assistant scripts and plugin secrets): the agent of this repository must be able to run it.
  const parts=value=>value.split('.').map(Number),[minimum,current]=[parts(metadata.minAgentVersion),parts(/<Version>([^<]+)<\/Version>/.exec(agent)[1])];
  assert.equal(metadata.minAgentVersion,'4.16.0','the DHCP plugin needs the plugin host of agent 4.16.0');
  assert.ok(minimum.reduce((order,value,index)=>order||Math.sign(value-current[index]),0)<=0,'the DHCP plugin needs no newer agent than this one');
  assert.match(program, new RegExp(`Name = "dhcp", BaseVersion = "${metadata.version.replaceAll('.', '\\.')}"`));
  assert.match(program, /Capabilities = \["dhcp-read", \.\. DhcpChanges\.Operations\]/);
  assert.match(project, /<PublishSingleFile>true<\/PublishSingleFile>/);
  assert.match(project, /<Compile Include="\.\.\/shared\/PluginProtocol\.cs"/);
  assert.match(agent, /<Compile Include="\.\.\/plugins\/shared\/PluginProtocol\.cs"/, 'the agent links the same protocol file');
  const notes = JSON.parse(await readFile(path.join(root, `agent/plugins/dhcp/changelogs/${metadata.version}.json`), 'utf8'));
  assert.equal(planPluginRelease({ csproj: project, ref: 'refs/heads/main', name: 'dhcp', changelog: notes }).release, true, 'the changelog of the version is valid');
  // 1.1.2 rewrites the result messages in plain language; no new feature.
  assert.deepEqual([notes.features, notes.fixes.length], [[], 1]);
  assert.match(notes.fixes[0], /messages of the DHCP extension/);
  assert.deepEqual(planPluginRelease({ csproj: project, ref: 'refs/heads/main', tags: [], name: 'dhcp', changelog: notes }), { name: 'dhcp', version: '1.1.2', tag: 'plugin-dhcp-v1.1.2', release: true, prerelease: false }, 'the release plans plugin-dhcp-v1.1.2');
  assert.throws(() => pluginProjectMetadata(project.replace('<PluginRole>dhcp</PluginRole>', '<PluginRole>mail</PluginRole>'), 'dhcp'), /^Error: The plugin dhcp needs <PluginTarget> with an id of the detection catalog\.$/);
});

test('the DNS plugin project names version 1.0.5, target dns, the agent of this repository and the 16 capabilities of the plugin', async () => {
  const project = await readFile(path.join(root, 'agent/plugins/dns/ServerDesk.Plugin.Dns.csproj'), 'utf8'), program = await readFile(path.join(root, 'agent/plugins/dns/Program.cs'), 'utf8');
  const agent = await readFile(path.join(root, 'agent/v3/ServerDesk.Agent.csproj'), 'utf8');
  const metadata = pluginProjectMetadata(project, 'dns');
  const changes = await readFile(path.join(root, 'agent/plugins/dns/DnsChanges.cs'), 'utf8');
  const operations = [...(/Operations =\s*\[([^\]]+)\]/.exec(changes)?.[1] ?? '').matchAll(/"([a-z0-9-]+)"/g)].map(match => match[1]);
  assert.deepEqual([metadata.version, metadata.target, metadata.capabilities], ['1.0.5', 'dns', ['dns-read', 'dns-zone-read', ...operations]]);
  assert.equal(metadata.capabilities.length, 16, 'two reads and 14 changes, within the limit of 32');
  // The DNS reads need the agent whose upload of the read data works: 4.21.2, which the agent of this repository includes.
  const parts = version => version.split('.').map(Number), atLeast = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]; return true; };
  assert.equal(metadata.minAgentVersion, '4.21.2', 'the DNS plugin 1.0.5 needs agent 4.21.2');
  assert.ok(atLeast(parts(/<Version>([^<]+)<\/Version>/.exec(agent)[1]), parts(metadata.minAgentVersion)), 'the agent of this repository runs the DNS plugin');
  const { pluginOperations } = await import('../../lib/plugin-catalog.ts');
  assert.deepEqual(metadata.capabilities, Object.entries(pluginOperations).filter(([, definition]) => definition.plugin === 'dns').map(([id]) => id), 'the portal knows exactly the operations of the plugin');
  assert.match(program, /Name = "dns", BaseVersion = "1\.0\.5", Version = BaseVersion \+ BuildVersion\.DevSuffix;/);
  assert.match(program, /Capabilities = \["dns-read", "dns-zone-read", \.\. DnsChanges\.Operations\]/);
  assert.match(project, /<PublishSingleFile>true<\/PublishSingleFile>/);
  assert.match(project, /<PublishTrimmed>true<\/PublishTrimmed>/);
  assert.match(project, /<Compile Include="\.\.\/shared\/PluginProtocol\.cs"/);
  const notes = JSON.parse(await readFile(path.join(root, `agent/plugins/dns/changelogs/${metadata.version}.json`), 'utf8'));
  validateReleaseChangelog(notes, '1.0.5');
  // 1.0.5 rewrites the result messages in plain language; no new feature.
  assert.deepEqual([notes.features, notes.fixes.length], [[], 1]);
  assert.match(notes.fixes[0], /messages of the DNS extension/);
  assert.deepEqual(planPluginRelease({ csproj: project, ref: 'refs/heads/main', tags: [], name: 'dns', changelog: notes }), { name: 'dns', version: '1.0.5', tag: 'plugin-dns-v1.0.5', release: true, prerelease: false }, 'the release plans plugin-dns-v1.0.5');
  assert.equal(pluginPaths('dns').project, 'agent/plugins/dns/ServerDesk.Plugin.Dns.csproj');
});

test('the project metadata read <PluginTarget>, fall back to <PluginRole> and refuse an id outside the detection catalog', () => {
  const project = inner => `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><Version>1.0.0</Version>${inner}<PluginMinAgentVersion>4.16.0</PluginMinAgentVersion><PluginCapabilities>x-read</PluginCapabilities></PropertyGroup></Project>`;
  assert.equal(pluginProjectMetadata(project('<PluginTarget>veeam-agent</PluginTarget>'), 'x').target, 'veeam-agent', '<PluginTarget>');
  assert.equal(pluginProjectMetadata(project('<PluginRole>dhcp</PluginRole>'), 'x').target, 'dhcp', 'only <PluginRole>');
  assert.equal(pluginProjectMetadata(project('<PluginTarget>dns</PluginTarget><PluginRole>dhcp</PluginRole>'), 'x').target, 'dns', '<PluginTarget> wins');
  for (const inner of ['<PluginTarget>mail</PluginTarget>', '<PluginRole>mail</PluginRole>', '', '<PluginTarget>mail</PluginTarget><PluginRole>dhcp</PluginRole>']) {
    assert.throws(() => pluginProjectMetadata(project(inner), 'x'), /^Error: The plugin x needs <PluginTarget> with an id of the detection catalog\.$/, inner || 'neither');
  }
});

test('the signing script writes target and an equal role into the manifest', () => {
  const exe = { path: '/downloads/ServerDesk-Plugin-dhcp-1.1.1-win-x64.exe', sha256: 'b'.repeat(64), size: 10 };
  const artifact = { name: 'dhcp', version: '1.1.1', target: 'dhcp', minAgentVersion: '4.16.0', capabilities: ['dhcp-read'], os: ['Windows Server 2022'], exe };
  const manifest = pluginReleaseManifest({ name: 'dhcp', artifact, parts: [], changelog: { features: ['Reads the DHCP server.'], fixes: [] }, createdAt: Date.UTC(2026, 10, 14) });
  assert.deepEqual([manifest.target, manifest.role], ['dhcp', 'dhcp']);
  assert.deepEqual(Object.keys(manifest).slice(0, 4), ['kind', 'name', 'target', 'role']);
  assert.throws(() => pluginReleaseManifest({ name: 'dhcp', artifact: { ...artifact, target: 'mail' }, parts: [], changelog: { features: ['Reads the DHCP server.'], fixes: [] }, createdAt: 1 }), /The plugin target is not an id of the detection catalog\./);
});

const workflowText = await readFile(path.join(repository, '.github', 'workflows', 'plugin-release.yml'), 'utf8');
const workflow = yaml.load(workflowText), jobs = workflow.jobs ?? {};

test('the plugin workflow runs by hand with a plugin choice, read access, one concurrency group and four jobs', () => {
  assert.equal(workflow.name, 'Plugin release');
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.plugin, { description: 'The plugin to release', required: true, type: 'choice', options: ['dhcp', 'dns'] });
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(workflow.concurrency, { group: 'plugin-release', 'cancel-in-progress': false });
  assert.deepEqual(Object.keys(jobs), ['plan', 'build', 'sign', 'release']);
  assert.equal(jobs.plan['runs-on'], 'ubuntu-latest');
  assert.equal(jobs.build['runs-on'], 'windows-latest');
  assert.match(jobs.plan.steps.at(-1).run, /node scripts\/plugin-release\.mjs plan --plugin "\$PLUGIN"/);
  assert.match(jobs.build.steps.find(step => step.name === 'Build and self-test the plugin').run, /node scripts\/build-plugin\.mjs --plugin "\$PLUGIN"/);
});

test('the plugin workflow pins its actions, keeps the key in the sign job and publishes with --latest=false', async () => {
  for (const line of workflowText.split(/\r?\n/).filter(line => /^\s*(?:- )?uses:/.test(line))) assert.match(line, /@[0-9a-f]{40} # v\d+\.\d+\.\d+$/, line);
  for (const job of Object.values(jobs)) for (const step of job.steps) if (step.uses?.startsWith('actions/checkout')) assert.equal(step.with['persist-credentials'], false);
  assert.equal(JSON.stringify(workflow).split('secrets.').length - 1, 1, 'secrets. only once');
  assert.ok(JSON.stringify(jobs.sign).includes('secrets.AGENT_RELEASE_SIGNING_KEY'), 'the secret is in the sign job');
  assert.equal(jobs.sign.environment, 'agent-signing');
  assert.deepEqual(jobs.sign.permissions, { contents: 'read' });
  for (const step of jobs.sign.steps) assert.doesNotMatch(step.run ?? '', /pnpm|npm |dotnet/, `no install or build tool in sign: ${step.name}`);
  for (const step of jobs.build.steps) assert.doesNotMatch(step.run ?? '', /pnpm install/, `no package install in build: ${step.name}`);
  const download = jobs.sign.steps.find(step => step.uses?.startsWith('actions/download-artifact'));
  assert.equal(download.with.path, '${{ runner.temp }}/plugin-build', 'the build is downloaded outside the checkout');
  const signing = jobs.sign.steps.find(step => step.name === 'Sign the release record').run;
  assert.match(signing, /umask 077/);
  assert.match(signing, /trap 'rm -f "\$KEY_FILE"' EXIT/);
  assert.match(signing, /node scripts\/sign-plugin-release\.mjs --plugin "\$PLUGIN"/);
  assert.match(jobs.sign.steps.find(step => step.name === 'Copy the expected build files').run, /plugin-release\.mjs stage/);
  assert.deepEqual(jobs.release.permissions, { contents: 'write' });
  const steps = jobs.release.steps.map(step => step.name);
  assert.ok(steps.indexOf('Verify the release assets') < steps.indexOf('Create the tag') && steps.indexOf('Create the tag') < steps.indexOf('Create the GitHub release'), 'verify, then tag, then publish');
  // --check-notes: the release job checks the notes.md that its own assets step wrote.
  assert.equal(jobs.release.steps.find(step => step.name === 'Verify the release assets').run, 'node scripts/plugin-release.mjs verify --plugin "$PLUGIN" --dir "$RUNNER_TEMP/plugin-release" --version "$VERSION" --check-notes');
  const publish = jobs.release.steps.find(step => step.name === 'Create the GitHub release').run;
  assert.match(publish, /--draft --latest=false/);
  assert.match(publish, /gh release edit "\$TAG" --draft=false --latest=false/);
  for (const asset of ['win-x64.exe', 'release.json', 'manifest.json', 'manifest.sig']) assert.ok(publish.includes(`"ServerDesk-Plugin-$PLUGIN-$VERSION-${asset}"`), asset);
  for (const step of Object.values(jobs).flatMap(job => job.steps)) assert.ok(!(step.run ?? '').includes('${{'), `no expression in run: ${step.name}`);
  // The scripts of the sign and release jobs use Node built-ins only.
  for (const file of ['scripts/plugin-release.mjs', 'scripts/sign-plugin-release.mjs', 'scripts/build-plugin.mjs', 'runtime/plugin-release-verify.mjs']) {
    const text = await readFile(path.join(root, file), 'utf8');
    for (const [, specifier] of text.matchAll(/^import [^'"]*['"]([^'"]+)['"]/gm)) assert.ok(specifier.startsWith('node:') || specifier.startsWith('.'), `${file} imports ${specifier}`);
  }
});

test('the plugin upload comment names the real artifact root', () => {
  const lines = workflowText.split(/\r?\n/), at = lines.findIndex(line => line.trim() === '- name: Upload the build');
  let first = at;
  while (lines[first - 1].trim().startsWith('#')) first--;
  const comment = lines.slice(first, at).map(line => line.trim().replace(/^#\s?/, '')).join(' ');
  assert.ok(first < at, 'a comment above the upload');
  assert.doesNotMatch(comment, /relative to ServerDesk/);
  assert.match(comment, /the artifact root is ServerDesk\/\.build/);
  assert.match(comment, /The sign job copies the expected files back into \.build\//);
});

// Every process of the layout test gets the env of this process without any GITHUB_* variable.
const childEnv = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GITHUB_')));
/** The words of a run line with "$NAME" replaced from `variables`; only plain words and double quotes. */
const commandWords = (line, variables) => [...line.matchAll(/"([^"]*)"|(\S+)/g)].map(match => (match[1] ?? match[2]).replace(/\$([A-Z_]+)/g, (_all, name) => {
  if (!Object.hasOwn(variables, name)) throw new Error(`No value for ${name} in: ${line}`);
  return variables[name];
}));

test('the sign job stages the plugin build in the layout that upload-artifact produces', async () => {
  const upload = jobs.build.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
  const download = jobs.sign.steps.find(step => step.uses?.startsWith('actions/download-artifact@'));
  const stage = jobs.sign.steps.find(step => step.name === 'Copy the expected build files');
  assert.equal(download.with.name, upload.with.name, 'the sign job downloads the artifact of the build job');
  for (const [name, version] of [['dns', '1.0.5'], ['dns', '1.0.5-dev.abc1234'], ['dhcp', '1.1.2'], ['dhcp', '1.1.2-dev.abc1234']]) {
    const label = `${name} ${version}`, exe = `ServerDesk.Plugin.${pluginPascalName(name)}.exe`;
    const directory = await mkdtemp(path.join(os.tmpdir(), 'sd-plugin-layout-'));
    try {
      const runnerTemp = path.join(directory, 'runner-temp');
      const expression = text => {
        const value = text.replaceAll('${{ needs.plan.outputs.name }}', name).replaceAll('${{ needs.plan.outputs.version }}', version).replaceAll('${{ runner.temp }}', runnerTemp);
        assert.ok(!value.includes('${{'), `an expression the test does not know: ${value}`);
        return value;
      };
      // What the build job leaves in the workspace: one EXE in the publish folder (build-plugin.mjs) and files the upload leaves out.
      const built = {
        [`ServerDesk/.build/plugin-${name}-artifact.json`]: JSON.stringify({ name, version }),
        [`ServerDesk/.build/plugin-${name}-publish/${exe}`]: `exe ${label}`,
      };
      const workspace = [...Object.keys(built), `ServerDesk/.build/plugin-${name}-publish/${exe}.config`, 'ServerDesk/.build/agent-v3-artifact.json', 'ServerDesk/scripts/plugin-release.mjs'];
      const lines = expression(upload.with.path).split('\n').map(line => line.trim()).filter(Boolean);
      const layout = uploadArtifactLayout(lines, Object.fromEntries(lines.map(line => [line, filesOfUploadPath(line, workspace)])));
      assert.equal(layout.root, 'ServerDesk/.build', label);
      assert.deepEqual(layout.entries.map(item => item.file).sort(), Object.keys(built).sort(), `${label}: the upload holds the metadata and the one EXE`);
      const downloaded = expression(download.with.path);
      for (const { file, entry } of layout.entries) {
        await mkdir(path.dirname(path.join(downloaded, entry)), { recursive: true });
        await writeFile(path.join(downloaded, entry), built[file]);
      }
      const checkout = path.join(directory, 'checkout');
      for (const file of ['scripts/plugin-release.mjs', 'scripts/release-changelog.mjs', 'runtime/plugin-release-verify.mjs', 'runtime/release-version.mjs']) {
        await mkdir(path.dirname(path.join(checkout, 'ServerDesk', file)), { recursive: true });
        await writeFile(path.join(checkout, 'ServerDesk', file), await readFile(path.join(root, file)));
      }
      const variables = { RUNNER_TEMP: runnerTemp, ...Object.fromEntries(Object.entries(stage.env).map(([key, value]) => [key, expression(value)])) };
      const [program, ...args] = commandWords(stage.run, variables);
      assert.equal(program, 'node');
      const result = spawnSync(process.execPath, args, { cwd: path.join(checkout, stage['working-directory']), encoding: 'utf8', env: childEnv() });
      assert.equal(result.status, 0, `${label}: ${result.stderr}`);
      assert.ok(result.stdout.includes(`Copied 2 build files: .build/plugin-${name}-artifact.json, .build/plugin-${name}-publish/${exe}.`), result.stdout);
      for (const [file, content] of Object.entries(built)) assert.equal(await readFile(path.join(checkout, file), 'utf8'), content, file);
      assert.deepEqual((await readdir(path.join(checkout, 'ServerDesk'))).sort(), ['.build', 'runtime', 'scripts'], 'the stage writes only into .build/');
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test('the plugin workflow: plan outputs prerelease, the build takes the plan version, sign and release on main or dev, --prerelease only on the dev path', () => {
  assert.equal(jobs.plan.outputs.prerelease, '${{ steps.plan.outputs.prerelease }}');
  const build = jobs.build.steps.find(step => step.name === 'Build and self-test the plugin');
  assert.equal(build.env.SERVERDESK_PLUGIN_VERSION, '${{ needs.plan.outputs.version }}');
  for (const job of ['sign', 'release']) assert.equal(jobs[job].if, "needs.plan.outputs.release == 'true' && (github.ref == 'refs/heads/main' || github.ref == 'refs/heads/dev')", job);
  assert.equal(jobs.release.env.PRERELEASE, '${{ needs.plan.outputs.prerelease }}');
  const lines = jobs.release.steps.find(step => step.name === 'Create the GitHub release').run.split('\n').map(line => line.trim());
  assert.deepEqual(lines.filter(line => line.startsWith('gh release create')), [
    'gh release create "$TAG" "$@" --verify-tag --draft --prerelease --latest=false --title "Plugin $PLUGIN $VERSION" --notes-file notes.md',
    'gh release create "$TAG" "$@" --verify-tag --draft --latest=false --title "Plugin $PLUGIN $VERSION" --notes-file notes.md',
  ]);
  assert.equal(lines[lines.findIndex(line => line.includes('--prerelease')) - 1], 'elif [ "$PRERELEASE" = "true" ]; then');
  assert.deepEqual(lines.filter(line => line.startsWith('gh release edit')), ['gh release edit "$TAG" --draft=false --latest=false']);
  const header = workflowText.split('\nname:')[0];
  assert.match(header, /on main it publishes the release\n# plugin-<name>-vX\.Y\.Z, on dev the pre-release plugin-<name>-vX\.Y\.Z-dev\.<sha7>/);
  assert.match(header, /agent-signing with the owner as required reviewer, the deployment\n# branches main and dev/);
});

test('the agent workflow and ZIP stay single-EXE: no plugin file goes into the agent release', async () => {
  const agent = await readFile(path.join(repository, '.github', 'workflows', 'agent-release.yml'), 'utf8'), build = await readFile(path.join(root, 'scripts', 'build-agent-v3.mjs'), 'utf8');
  assert.doesNotMatch(agent, /plugin/i, 'the agent workflow names no plugin');
  assert.match(build, /zipSync\(\{'ServerDesk\.Agent\.exe':/, 'the agent ZIP holds exactly ServerDesk.Agent.exe');
  assert.match(await readFile(path.join(root, 'agent', 'v3', 'AgentUpdater.cs'), 'utf8'), /archive\.Entries\.Count != 1 \|\| archive\.Entries\[0\]\.FullName != "ServerDesk\.Agent\.exe"/, 'the updater keeps its single-EXE rule');
  assert.equal(createHash('sha256').update('').digest('hex').length, 64);
});
