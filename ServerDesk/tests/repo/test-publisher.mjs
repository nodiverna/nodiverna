// The throwaway test publisher (scripts/test-publisher.mjs): pin rewrites the
// pin files and installer anchors of a copy of the tree consistently and
// creates the key once; release writes a signed release folder that the
// import accepts with that key; keys below .data/, the production key and a
// tree inside a git work tree without the copy mark are refused.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { agentReleaseFiles, verifyAgentRelease } from '../../runtime/agent-release-verify.mjs';
import { importReleaseFolder } from '../../runtime/release-import.mjs';
import { createStorage } from '../../runtime/storage.mjs';
import { TestPublisherError, defaultExeSize, pinTestPublisher, productionPublisherFingerprint, publisherFingerprint, testPublisherWarning, writeTestRelease } from '../../scripts/test-publisher.mjs';
import { sourceDatabase } from '../support/source-database.mjs';
import { serverDeskRoot } from '../support/paths.mjs';

const root = serverDeskRoot;
const tree = ['scripts/test-publisher.mjs', 'scripts/package-agent-v3.mjs', 'runtime/agent-release-verify.mjs', 'runtime/release-manifest.mjs', 'runtime/release-version.mjs', 'lib/release-publisher.json',
  'agent/v3/Install-ServerDesk-V3.template.ps1', 'agent/v3/release-public.pem', 'agent/v3/ServerDesk.Agent.csproj', 'agent/Uninstall-ServerDesk.ps1', 'agent/package-v3.ts', 'public/Bootstrap-ServerDesk-V3.ps1'];
const point = pem => { const jwk = crypto.createPublicKey(pem).export({ format: 'jwk' }); return Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64'); };

async function copy(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'serverdesk-test-publisher-'));
  try {
    const copyRoot = path.join(directory, 'ServerDesk');
    for (const file of tree) { await mkdir(path.dirname(path.join(copyRoot, file)), { recursive: true }); await cp(path.join(root, file), path.join(copyRoot, file)); }
    const cli = args => spawnSync(process.execPath, ['scripts/test-publisher.mjs', ...args], { cwd: copyRoot, encoding: 'utf8' });
    return await run({ directory, copyRoot, cli });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('pin creates the key once, pins it in the pin files and both installer anchors and warns', () => copy(async ({ directory, copyRoot, cli }) => {
  const production = JSON.parse(await readFile(path.join(root, 'lib', 'release-publisher.json'), 'utf8')).publicKey;
  const key = path.join(directory, 'keys', 'test-publisher.pem');
  const pinned = cli(['pin', '--key', key]);
  assert.equal(pinned.status, 0, pinned.stderr);
  assert.ok(existsSync(key), 'the key is created');
  if (process.platform !== 'win32') assert.equal(statSync(key).mode & 0o777, 0o600, 'the key is readable only by its owner');
  const publicKey = crypto.createPublicKey(await readFile(key)).export({ type: 'spki', format: 'pem' }).toString();
  assert.equal(pinned.stdout.trim(), `Test publisher public-key SHA-256: ${publisherFingerprint(publicKey)}`);
  assert.equal(pinned.stderr.trim(), testPublisherWarning);
  assert.equal(testPublisherWarning, 'This tree now trusts a test publisher. Never commit it.');
  const read = file => readFile(path.join(copyRoot, file), 'utf8');
  assert.equal(JSON.parse(await read('lib/release-publisher.json')).publicKey, publicKey);
  assert.equal(await read('agent/v3/release-public.pem'), publicKey);
  for (const file of ['agent/package-v3.ts', 'public/Bootstrap-ServerDesk-V3.ps1']) {
    const text = await read(file);
    assert.ok(text.includes(point(publicKey)), `${file} embeds the test anchor`);
    assert.ok(!text.includes(point(production)), `${file} no longer embeds the production anchor`);
  }
  // A second pin keeps the existing key.
  const before = await readFile(key, 'utf8');
  assert.equal(cli(['pin', '--key', key]).status, 0);
  assert.equal(await readFile(key, 'utf8'), before);
  // The original tree is untouched.
  assert.equal(JSON.parse(await readFile(path.join(root, 'lib', 'release-publisher.json'), 'utf8')).publicKey, production);
}));

test('release writes the five asset names in the path form, signed and checked with the key; the folder imports with that key', () => copy(async ({ directory, copyRoot, cli }) => {
  const key = path.join(directory, 'test-publisher.pem');
  assert.equal(cli(['pin', '--key', key]).status, 0);
  const out = path.join(directory, 'release');
  const written = cli(['release', '--key', key, '--out', out, '--version', '4.90.0']);
  assert.equal(written.status, 0, written.stderr);
  const result = JSON.parse(written.stdout), names = agentReleaseFiles('4.90.0');
  assert.deepEqual((await readdir(out)).sort(), Object.values(names).sort(), 'exactly the five names of the CI');
  const record = JSON.parse(await readFile(path.join(out, names.record), 'utf8'));
  assert.equal(result.id, record.id);
  const files = { zip: await readFile(path.join(out, names.zip)), exe: await readFile(path.join(out, names.exe)) };
  assert.equal(files.exe.length, defaultExeSize, 'the default EXE is 20 MiB and one byte');
  const publicKeyPem = JSON.parse(await readFile(path.join(copyRoot, 'lib', 'release-publisher.json'), 'utf8')).publicKey;
  const manifest = verifyAgentRelease({ record, files, publicKeyPem, version: '4.90.0' });
  assert.equal(manifest.exe.parts.length, 2, 'two EXE parts');
  assert.ok(!record.manifest.includes('"url"'), 'the path form');
  assert.equal(await readFile(path.join(out, names.manifest), 'utf8'), record.manifest);
  assert.equal(await readFile(path.join(out, names.signature), 'utf8'), record.signature);
  // The import of a portal pinned to this key accepts the folder.
  const database = await sourceDatabase();
  try {
    const storage = createStorage({ OBJECT_STORAGE_DRIVER: 'filesystem', OBJECT_STORAGE_PATH: path.join(directory, 'objects') });
    assert.deepEqual(await importReleaseFolder(database, { directory: out, storage, publicKeyPem }), { version: '4.90.0', releaseId: record.id, status: 'imported' });
  } finally { await database.close(); }
  // A small EXE has no parts; the version defaults to the project file.
  const small = path.join(directory, 'small');
  const smallRun = cli(['release', '--key', key, '--out', small, '--exe-size', '4096']);
  assert.equal(smallRun.status, 0, smallRun.stderr);
  const csproj = /<Version>([^<]*)<\/Version>/.exec(await readFile(path.join(root, 'agent', 'v3', 'ServerDesk.Agent.csproj'), 'utf8'))[1];
  assert.equal(JSON.parse(smallRun.stdout).version, csproj);
  assert.equal(JSON.parse(JSON.parse(await readFile(path.join(small, agentReleaseFiles(csproj).record), 'utf8')).manifest).exe.parts, undefined);
}));

test('both commands refuse a key below .data/ and wrong arguments', () => copy(async ({ directory, copyRoot, cli }) => {
  const message = file => `${file} is below a .data/ directory. The test publisher never uses the production key .data/release-private.pem; pass a key file outside .data/.`;
  await mkdir(path.join(copyRoot, '.data'));
  const production = path.join(copyRoot, '.data', 'release-private.pem');
  await writeFile(production, crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const before = await readFile(path.join(copyRoot, 'lib', 'release-publisher.json'), 'utf8');
  for (const file of ['.data/release-private.pem', production, path.join(directory, 'other', '.data', 'test.pem')]) {
    for (const args of [['pin', '--key', file], ['release', '--key', file, '--out', path.join(directory, 'out')]]) {
      const refused = cli(args);
      assert.deepEqual([refused.status, refused.stderr.trim()], [1, message(file)], args.join(' '));
    }
  }
  assert.equal(existsSync(path.join(directory, 'other')), false, 'no key is created below .data/');
  assert.equal(existsSync(path.join(directory, 'out')), false);
  assert.equal(await readFile(path.join(copyRoot, 'lib', 'release-publisher.json'), 'utf8'), before, 'the pin stays');
  const usage = 'Usage: node scripts/test-publisher.mjs pin --key <file> | release --key <file> --out <dir> [--version X.Y.Z] [--exe-size <bytes>]';
  for (const args of [[], ['pin'], ['release', '--key', path.join(directory, 'k.pem')], ['publish', '--key', path.join(directory, 'k.pem')]]) {
    const failed = cli(args);
    assert.deepEqual([failed.status, failed.stderr.trim()], [1, usage], args.join(' '));
  }
  const missing = cli(['release', '--key', path.join(directory, 'none.pem'), '--out', path.join(directory, 'out')]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /none\.pem does not exist\. Create it with: node scripts\/test-publisher\.mjs pin --key /);
}));

// ---- Only a throwaway copy, never the production key ---------------------------------
const pinFiles = ['lib/release-publisher.json', 'agent/v3/release-public.pem', 'agent/package-v3.ts', 'public/Bootstrap-ServerDesk-V3.ps1'];
const snapshot = copyRoot => Promise.all(pinFiles.map(file => readFile(path.join(copyRoot, file), 'utf8')));
const gitMessage = ' is a git checkout. pin rewrites the committed publisher pin, so it runs only in a throwaway copy: use pnpm test:http.';
const withoutMark = () => { const env = { ...process.env }; delete env.SERVERDESK_TEST_PUBLISHER_COPY; return env; };

test('pin refuses a tree inside a git work tree unless SERVERDESK_TEST_PUBLISHER_COPY names exactly that tree', () => copy(async ({ directory, copyRoot }) => {
  const cli = (args, mark) => spawnSync(process.execPath, ['scripts/test-publisher.mjs', ...args], { cwd: copyRoot, encoding: 'utf8', env: mark === undefined ? withoutMark() : { ...withoutMark(), SERVERDESK_TEST_PUBLISHER_COPY: mark } });
  const before = await snapshot(copyRoot);
  // A .git directory or a .git file (a linked worktree), in the copy or in a parent.
  for (const [where, kind] of [[copyRoot, 'directory'], [copyRoot, 'file'], [directory, 'directory'], [directory, 'file']]) {
    const entry = path.join(where, '.git');
    if (kind === 'directory') await mkdir(entry); else await writeFile(entry, 'gitdir: /elsewhere/.git/worktrees/copy\n');
    const key = path.join(directory, 'keys', 'refused.pem');
    for (const mark of [undefined, path.join(directory, 'elsewhere'), directory]) {
      const refused = cli(['pin', '--key', key], mark);
      const text = refused.stderr.trim();
      assert.equal(refused.status, 1, `${where} ${kind} ${mark}`);
      assert.ok(text.endsWith(gitMessage), text);
      assert.equal(realpathSync(text.slice(0, -gitMessage.length)), realpathSync(copyRoot), 'the message names the tree');
      assert.equal(existsSync(key), false, 'no key is created');
      assert.deepEqual(await snapshot(copyRoot), before, 'the pin, the PEM and both anchors stay');
    }
    // An existing key file stays as it is.
    const existing = path.join(directory, 'existing.pem'), pem = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
    await writeFile(existing, pem);
    assert.equal(cli(['pin', '--key', existing]).status, 1);
    assert.equal(await readFile(existing, 'utf8'), pem);
    // The mark of exactly this tree lets pin run.
    const pinned = cli(['pin', '--key', existing], copyRoot);
    assert.equal(pinned.status, 0, pinned.stderr);
    assert.equal(publisherFingerprint(JSON.parse(await readFile(path.join(copyRoot, 'lib', 'release-publisher.json'), 'utf8')).publicKey), publisherFingerprint(pem));
    for (const [file, text] of pinFiles.map((file, index) => [file, before[index]])) await writeFile(path.join(copyRoot, file), text);
    await rm(existing);
    await rm(entry, { recursive: true });
  }
  // Without a .git entry (a copy in the temporary directory) pin runs without the mark.
  const plain = cli(['pin', '--key', path.join(directory, 'plain.pem')]);
  assert.equal(plain.status, 0, plain.stderr);
}));

test('pin and release refuse the production publisher key and write nothing; the production fingerprint has one source', () => copy(async ({ directory, copyRoot }) => {
  assert.equal(productionPublisherFingerprint, '01a31e1fed62d88f179c7e8797a6745d5e41aa91c8f3497c02f345812e7c1d85');
  assert.equal(publisherFingerprint(JSON.parse(await readFile(path.join(root, 'lib', 'release-publisher.json'), 'utf8')).publicKey), productionPublisherFingerprint, 'the committed pin is the exported fingerprint');
  // A throwaway key stands for the production key through the injected fingerprint.
  const key = path.join(directory, 'stand-in.pem'), pem = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  await writeFile(key, pem);
  const productionFingerprint = publisherFingerprint(pem), before = await snapshot(copyRoot), out = path.join(directory, 'out');
  const message = `${key} holds the production publisher key. The test publisher never uses it; pass a throwaway key file.`;
  assert.throws(() => pinTestPublisher({ key, tree: copyRoot, env: {}, productionFingerprint }), error => error instanceof TestPublisherError && error.message === message);
  assert.throws(() => writeTestRelease({ key, out, version: '4.90.0', exeSize: 16, tree: copyRoot, productionFingerprint }), error => error instanceof TestPublisherError && error.message === message);
  assert.deepEqual(await snapshot(copyRoot), before, 'the pin files stay');
  assert.equal(existsSync(out), false, 'no release folder is written');
  assert.equal(await readFile(key, 'utf8'), pem);
  // The .data/ refusal runs first.
  const below = path.join(directory, '.data', 'release-private.pem');
  assert.throws(() => pinTestPublisher({ key: below, tree: copyRoot, env: {}, productionFingerprint }), { message: `${below} is below a .data/ directory. The test publisher never uses the production key .data/release-private.pem; pass a key file outside .data/.` });
  // Any other key passes with the real fingerprint.
  assert.match(pinTestPublisher({ key, tree: copyRoot, env: {} }), /^[0-9a-f]{64}$/);
}));
