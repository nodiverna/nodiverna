// The release catalog (lib/server/agent/releases.ts) on PostgreSQL: only path-form manifests
// of the pinned publisher whose files the portal serves are listed, and the
// consistency "catalog ⇔ files" after imports, disable, delete and the chunk
// cleanup. A throwaway P-256 key is the publisher (scripts/test-publisher.mjs).
import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sql } from '../../runtime/database.mjs';
import { importReleaseFolder, runReleaseCheck } from '../../runtime/release-import.mjs';
import { createStorage } from '../../runtime/storage.mjs';
import { writeTestRelease } from '../../scripts/test-publisher.mjs';
import { dbModule, sourceDatabase, sourceLoader } from '../support/source-database.mjs';
import { HttpError } from '../support/http-error.mjs';

const require = createRequire(import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const publisher = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const publicKeyPem = publisher.publicKey.export({ format: 'pem', type: 'spki' }).toString();
const origin = 'https://192.168.1.10:8443';

/** lib/server/agent/releases.ts and the download route with this publisher, the shared test database and `storage`. */
function libraries(storage, settings = { SITE_ORIGIN: origin }) {
  const load = sourceLoader();
  const server = { HttpError, now: () => Date.now(), config: key => settings[key] ?? '', failure: error => Response.json({ messageKey: error.messageKey }, { status: error.status ?? 500 }) };
  const imports = { '../context': server,'./context':server, '@/lib/server/context': server, '../../release-publisher.json': { default: { publicKey: publicKeyPem } }, 'cloudflare:workers': { env: { BUCKET: storage } } };
  return { app: load('lib/server/agent/releases.ts', imports), route: load('app/downloads/[file]/route.ts', imports), settings };
}

async function fixture(run) {
  const database = await sourceDatabase();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sd-release-catalog-'));
  const storage = createStorage({ OBJECT_STORAGE_DRIVER: 'filesystem', OBJECT_STORAGE_PATH: path.join(directory, 'objects') });
  try { await run({ database, storage, directory, ...libraries(storage) }); } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

// A small signed path-form release with its rows, as the import writes them.
function signed(manifest) {
  const text = JSON.stringify(manifest);
  return { id: randomUUID(), version: manifest.version, manifest: text, signature: sign('sha256', Buffer.from(text), publisher.privateKey).toString('base64'), sha256: manifest.sha256, size: manifest.size, createdAt: Date.parse(manifest.createdAt) };
}
function pathManifest(version, { parts = true } = {}) {
  const part = (name, size, character) => ({ path: `/downloads/${name}`, size, sha256: character.repeat(64) });
  return {
    version, protocolVersion: 3, minProtocolVersion: 3, os: ['Windows Server 2025'], arch: 'x64',
    path: `/downloads/agent-${version}.zip`, size: 5, sha256: 'a'.repeat(64), ...(parts ? { parts: [part(`agent-${version}.zip.part1`, 2, 'b'), part(`agent-${version}.zip.part2`, 3, 'c')] } : {}),
    layout: 'single-exe', exe: { path: `/downloads/agent-${version}.exe`, size: 9, sha256: 'd'.repeat(64), ...(parts ? { parts: [part(`agent-${version}.exe.part1`, 4, 'e'), part(`agent-${version}.exe.part2`, 5, 'f')] } : {}) },
    createdAt: '2026-10-10T12:00:00.000Z',
  };
}
async function store(database, release, { files = true, createdAt = release.createdAt, omit = [], change = {} } = {}) {
  await database.exec(sql`INSERT INTO agent_releases(id,version,manifest,signature,sha256,size,created_at) VALUES(${release.id},${release.version},${release.manifest},${release.signature},${release.sha256},${release.size},${createdAt})`);
  if (!files) return;
  const manifest = JSON.parse(release.manifest);
  const entries = [manifest, ...(manifest.parts ?? []), manifest.exe, ...(manifest.exe.parts ?? [])];
  for (const entry of entries) {
    if (omit.includes(entry.path)) continue;
    const { size, sha256 } = { size: entry.size, sha256: entry.sha256, ...change[entry.path] };
    await database.exec(sql`INSERT INTO agent_release_files(release_id,path,size,sha256,chunks) VALUES(${release.id},${entry.path},${size},${sha256},${JSON.stringify([{ sha256, size }])})`);
  }
}

test('the committed publisher pin matches the native agent resource', async () => {
  const metadata = JSON.parse(await readFile(new URL('../../lib/release-publisher.json', import.meta.url), 'utf8'));
  const agentPin = await readFile(new URL('../../agent/v3/release-public.pem', import.meta.url), 'utf8');
  const canonical = key => createPublicKey(key).export({ format: 'der', type: 'spki' });
  assert.deepEqual(canonical(metadata.publicKey), canonical(agentPin));
  assert.equal(createPublicKey(metadata.publicKey).asymmetricKeyDetails.namedCurve, 'prime256v1');
});

test('only the path form verifies, on every origin; the absolute form is refused', () => {
  const { app, settings } = libraries(null);
  const release = signed(pathManifest('4.12.0'));
  assert.equal(app.verifiedRelease(release.manifest, release.signature).exe.path, '/downloads/agent-4.12.0.exe');
  settings.SITE_ORIGIN = 'https://serverdesk.azure.example';
  assert.equal(app.verifiedRelease(release.manifest, release.signature).version, '4.12.0', 'the same signature on another origin');
  const toUrls = value => JSON.parse(JSON.stringify(value), (_key, item) => item && typeof item === 'object' && !Array.isArray(item) && Object.hasOwn(item, 'path')
    ? Object.fromEntries(Object.entries(item).map(([key, entry]) => key === 'path' ? ['url', settings.SITE_ORIGIN + entry] : [key, entry])) : item);
  for (const manifest of [toUrls(pathManifest('4.12.0')), { ...pathManifest('4.12.0'), exe: toUrls(pathManifest('4.12.0')).exe }]) {
    const absolute = signed(manifest);
    assert.throws(() => app.verifiedRelease(absolute.manifest, absolute.signature), { messageKey: 'apiError.release.invalidReleaseManifest' }, 'an absolute or mixed manifest, also on its own origin');
  }
  const foreign = sign('sha256', Buffer.from(release.manifest), generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey).toString('base64');
  assert.throws(() => app.verifiedRelease(release.manifest, foreign), { messageKey: 'apiError.release.signatureInvalid' });
  for (const invalid of ['/downloads/../x', '/downloads/a/b', '/other/x', '/downloads/x?y', '/downloads/%2e%2e', '/downloads/a\\b']) {
    const manifest = pathManifest('4.12.0'); manifest.exe.parts[1].path = invalid;
    const item = signed(manifest);
    assert.throws(() => app.verifiedRelease(item.manifest, item.signature), { messageKey: 'apiError.release.downloadPath' }, invalid);
  }
  const noExe = pathManifest('4.12.0'); delete noExe.exe; delete noExe.layout;
  assert.throws(() => app.verifiedRelease(signed(noExe).manifest, signed(noExe).signature), { messageKey: 'apiError.release.nativeNeedsSignedExe' });
});

test('the catalog lists a row only when it is not deleted, verifies and has a matching file row for every path', () => fixture(async ({ database, app }) => {
  const listed = signed(pathManifest('4.12.0')), small = signed(pathManifest('4.11.0', { parts: false }));
  const noFiles = signed(pathManifest('4.10.1')), missingPart = signed(pathManifest('4.10.2')), wrongSize = signed(pathManifest('4.10.3')), wrongHash = signed(pathManifest('4.10.4')), deleted = signed(pathManifest('4.10.5'));
  const badSignature = { ...signed(pathManifest('4.10.6')), signature: sign('sha256', Buffer.from('other bytes'), publisher.privateKey).toString('base64') };
  await store(database, listed);
  await store(database, small);
  await store(database, noFiles, { files: false });
  await store(database, missingPart, { omit: ['/downloads/agent-4.10.2.exe.part2'] });
  await store(database, wrongSize, { change: { '/downloads/agent-4.10.3.zip.part1': { size: 7 } } });
  await store(database, wrongHash, { change: { '/downloads/agent-4.10.4.exe': { sha256: '9'.repeat(64) } } });
  await store(database, deleted);
  await database.exec(sql`INSERT INTO agent_release_states VALUES(${deleted.id},'deleted',1,'owner')`);
  await store(database, badSignature);
  const catalog = await app.releases();
  assert.deepEqual(catalog.map(item => item.version), ['4.12.0', '4.11.0']);
  assert.deepEqual(Object.keys(catalog[0]).sort(), ['active', 'changelog', 'createdAt', 'dev', 'id', 'latest', 'manifest', 'sha256', 'signature', 'size', 'version'], 'no legacyForm');
  for (const item of [noFiles, missingPart, wrongSize, wrongHash, deleted, badSignature]) {
    await assert.rejects(app.releaseEnvelopes(item.id), { messageKey: 'apiError.release.notFound' }, item.version);
    await assert.rejects(app.releaseById(item.id), { messageKey: 'apiError.release.notFound' }, item.version);
  }
  const envelopes = await app.releaseEnvelopes(listed.id);
  assert.deepEqual(Object.keys(envelopes).sort(), ['path', 'release'], 'only the path envelope');
  assert.equal(envelopes.path.manifest, listed.manifest);
}));

test('latest is the active release with the highest version; ties go to the newest row', () => fixture(async ({ database, app }) => {
  const older = signed(pathManifest('4.12.0')), high = signed(pathManifest('4.13.0'));
  await store(database, older, { createdAt: 1000 });
  // The same version again (stored directly; the import would refuse it) with its own file names.
  const renamed = pathManifest('4.12.0');
  for (const entry of [renamed, ...renamed.parts, renamed.exe, ...renamed.exe.parts]) entry.path = entry.path.replace('agent-', 'other-');
  const tie = signed(renamed);
  await store(database, tie, { createdAt: 2000 });
  assert.equal((await app.releases()).find(item => item.latest).id, tie.id, 'the newest row of the highest version');
  await store(database, high, { createdAt: 500 });
  assert.equal((await app.latestRelease()).id, high.id);
  await database.exec(sql`INSERT INTO agent_release_states VALUES(${high.id},'disabled',1,'owner')`);
  const catalog = await app.releases();
  assert.deepEqual(catalog.map(item => [item.version, item.active, item.latest]), [['4.13.0', false, false], ['4.12.0', true, true], ['4.12.0', true, false]], 'a disabled release stays listed but is never latest');
}));

test('readiness does not check releases: an empty catalog is ready', async () => {
  const database = await sourceDatabase();
  try {
    await import('../support/register.mjs');
    const { isReady } = await import('../../lib/server/readiness.ts');
    assert.equal(Number((await database.one(sql`SELECT count(*) AS n FROM agent_releases`)).n), 0);
    assert.equal(await isReady({ database, bucket: { head: async () => null } }), true);
    const route = sourceLoader()('app/api/health/ready/route.ts', { '@/lib/server/readiness': sourceLoader()('lib/server/readiness.ts', { 'cloudflare:workers': { env: { BUCKET: { head: async () => null } } }, './db': dbModule(), '../../drizzle/meta/_journal.json': { default: require('../../drizzle/meta/_journal.json') } }) });
    const response = await route.GET();
    assert.deepEqual([response.status, await response.json()], [200, { status: 'ok' }]);
  } finally { await database.close(); }
});

test('catalog ⇔ files: after imports, disable, delete and cleanup every catalog path serves its signed bytes and every served path belongs to a catalog release', () => fixture(async ({ database, storage, directory, app, route }) => {
  const key = path.join(directory, 'test-publisher.pem');
  await writeFile(key, publisher.privateKey.export({ format: 'pem', type: 'pkcs8' }));
  const folder = name => path.join(directory, name);
  // A has two-part files, B and C are small. C stays active and latest.
  const a = writeTestRelease({ key, out: folder('a'), version: '4.12.0' });
  const b = writeTestRelease({ key, out: folder('b'), version: '4.12.1', exeSize: 4096 });
  const c = writeTestRelease({ key, out: folder('c'), version: '4.12.2', exeSize: 2048 });
  for (const release of [a, b, c]) assert.equal((await importReleaseFolder(database, { directory: release.directory, storage, publicKeyPem })).status, 'imported');
  assert.equal((await app.retireRelease(a.id, 'disable', 'owner', sql`TRUE`)).release.version, '4.12.0');
  await app.retireRelease(b.id, 'delete', 'owner', sql`TRUE`);
  // The cleanup of the next check, a week later: the chunks of B are no longer referenced.
  const week = Date.now() + 7 * 24 * 60 * 60_000;
  const result = await runReleaseCheck(database, { storage, fetch: async () => Response.json([]), clock: () => week, timers: { setInterval: () => null, clearInterval: () => {} }, log: () => {}, publicKeyPem });
  assert.equal(result.removedChunks, 2, 'the ZIP and the EXE chunk of B');
  const catalog = await app.releases();
  assert.deepEqual(catalog.map(item => [item.version, item.active]), [['4.12.2', true], ['4.12.0', false]], 'B is not in the catalog');
  const get = async pathname => { const file = pathname.slice('/downloads/'.length); return route.GET(new Request(origin + pathname), { params: Promise.resolve({ file }) }); };
  // (a) Every manifest path of every catalog release gives the exact signed bytes.
  const slice = (bytes, index) => bytes.subarray(index * 20 * 1024 * 1024, Math.min((index + 1) * 20 * 1024 * 1024, bytes.length));
  for (const item of catalog) {
    const manifest = JSON.parse(item.manifest), source = [a, c].find(release => release.id === item.id);
    const bytes = { zip: await readFile(path.join(source.directory, source.files.zip)), exe: await readFile(path.join(source.directory, source.files.exe)) };
    const expected = [[manifest.path, bytes.zip], ...(manifest.parts ?? []).map((part, index) => [part.path, slice(bytes.zip, index)]), [manifest.exe.path, bytes.exe], ...(manifest.exe.parts ?? []).map((part, index) => [part.path, slice(bytes.exe, index)])];
    for (const [pathname, content] of expected) {
      const response = await get(pathname);
      assert.equal(response.status, 200, pathname);
      const body = Buffer.from(await response.arrayBuffer());
      assert.equal(hash(body), hash(content), pathname);
    }
  }
  assert.ok(JSON.parse(catalog.find(item => item.id === a.id).manifest).exe.parts.length === 2, 'A has EXE parts');
  // (b) Every stored path that the route serves belongs to a catalog release; the paths of B are not served.
  const listed = new Set(catalog.map(item => item.id));
  for (const row of await database.query(sql`SELECT release_id,path FROM agent_release_files ORDER BY path`)) {
    const response = await get(row.path);
    if (listed.has(row.release_id)) { assert.equal(response.status, 200, row.path); await response.body?.cancel(); continue; }
    assert.equal(row.release_id, b.id, 'only B is not listed');
    assert.deepEqual([response.status, (await response.json()).messageKey], [404, 'apiError.download.fileNotFound'], `${row.path} of the deleted release`);
  }
}));
