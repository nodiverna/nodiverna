// Agent releases from GitHub (runtime/release-import.mjs) on PostgreSQL: a fake
// fetch serves the GitHub list and the assets, a throwaway P-256 publisher is
// passed as the test-only key and the files go to filesystem storage in a temp
// folder. No request leaves this process. The public repository is read without
// sign-in: no request carries an Authorization header, a rate-limited answer
// gives rateLimited and stops the downloads of the check, and the next check
// tries again. rewrap-secrets and import-release know no release token.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { compile, createDatabase, sql } from '../../runtime/database.mjs';
import { agentReleaseFiles, agentReleasePartSize } from '../../runtime/agent-release-verify.mjs';
import {
  releaseAssetUrl, releaseChunkKey, releaseImportFailures, releaseImportReasonText, releaseListUrl, runReleaseCheck, maintenanceReleaseCheck, streamReleaseFile,
} from '../../runtime/release-import.mjs';
import * as releaseImport from '../../runtime/release-import.mjs';
import { createStorage } from '../../runtime/storage.mjs';
import { importRelease, rewrapSecrets } from '../../scripts/selfhost.mjs';
import { sourceDatabase, sourceLoader } from '../support/source-database.mjs';
import { HttpError } from '../support/http-error.mjs';
import { testDatabase } from '../support/postgres.mjs';
import { serverDeskRoot } from '../support/paths.mjs';

const projectRoot = serverDeskRoot;
const portalVersion = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
const publisher = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), foreign = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const publicKeyPem = publisher.publicKey.export({ type: 'spki', format: 'pem' });
const secret = 'session-secret-for-release-import-tests-0001';
const origin = 'https://portal.test';
const kinds = ['zip', 'exe', 'record', 'manifest', 'signature'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function fakeTimers() {
  const entries = [];
  return { entries, setInterval(fn, ms) { const entry = { fn, ms, cleared: false, unref() { return this; } }; entries.push(entry); return entry; }, clearInterval(entry) { if (entry) entry.cleared = true; } };
}

// ---- Releases as the CI publishes them --------------------------------------------
let nextAssetId = 1000;
function partsOf(bytes, base) {
  if (bytes.length <= agentReleasePartSize) return undefined;
  return Array.from({ length: Math.ceil(bytes.length / agentReleasePartSize) }, (_, index) => {
    const slice = bytes.subarray(index * agentReleasePartSize, (index + 1) * agentReleasePartSize);
    return { path: `${base}.part${index + 1}`, sha256: hash(slice), size: slice.length };
  });
}
/** A signed release with its five assets; `edit` changes the manifest before it is signed. */
function buildRelease(version, { zip = Buffer.from(`zip of the agent ${version}`), exe = Buffer.from(`exe of the agent ${version}`), key = publisher.privateKey, edit = manifest => manifest, id = randomUUID() } = {}) {
  const names = agentReleaseFiles(version), zipParts = partsOf(zip, `/downloads/${names.zip}`), exeParts = partsOf(exe, `/downloads/${names.exe}`);
  const manifest = edit({
    version, protocolVersion: 3, minProtocolVersion: 3, os: ['Windows 11 Pro'], arch: 'x64', path: `/downloads/${names.zip}`, sha256: hash(zip), size: zip.length, ...(zipParts ? { parts: zipParts } : {}),
    layout: 'single-exe', exe: { path: `/downloads/${names.exe}`, sha256: hash(exe), size: exe.length, ...(exeParts ? { parts: exeParts } : {}) },
    changelog: { features: ['Imported from GitHub'], fixes: [] }, createdAt: '2026-11-01T00:00:00.000Z',
  });
  const text = JSON.stringify(manifest), signature = sign('sha256', Buffer.from(text), key).toString('base64');
  const record = { id, version, manifest: text, signature, sha256: manifest.sha256, size: manifest.size, createdAt: Date.UTC(2026, 10, 1) };
  const files = { zip, exe, record: Buffer.from(JSON.stringify(record, null, 2) + '\n'), manifest: Buffer.from(text), signature: Buffer.from(signature) };
  return { version, tag: `agent-v${version}`, names, record, manifest, files, ids: Object.fromEntries(kinds.map(kind => [kind, ++nextAssetId])) };
}
/** The GitHub list entry of a release. */
function listed(release, { draft = false, prerelease = false, tag = release.tag, omit = [], state = {}, sizes = {}, updatedAt = '2026-11-01T00:00:00Z' } = {}) {
  return { tag_name: tag, draft, prerelease, assets: kinds.filter(kind => !omit.includes(kind)).map(kind => ({ id: release.ids[kind], name: release.names[kind], state: state[kind] ?? 'uploaded', size: sizes[kind] ?? release.files[kind].length, updated_at: updatedAt })) };
}
const objectUrl = id => `https://objects.githubusercontent.com/github-production-release-asset/${id}?sig=signed`;
/**
 * A fake GitHub: the list, each asset endpoint redirects to githubusercontent.com,
 * which serves the bytes. `routes` answers single URLs; any other request throws.
 */
function github({ list = [], releases = [], routes = {}, bytes = {} } = {}) {
  const calls = [], assets = new Map();
  for (const release of releases) for (const kind of kinds) assets.set(release.ids[kind], bytes[release.ids[kind]] ?? release.files[kind]);
  const fetch = async (url, init = {}) => {
    calls.push({ url, headers: { ...init.headers }, redirect: init.redirect });
    if (Object.hasOwn(routes, url)) return routes[url](url, init);
    if (url === releaseListUrl) return typeof list === 'function' ? list() : Response.json(list);
    const asset = /^https:\/\/api\.github\.com\/repos\/nodiverna\/nodiverna\/releases\/assets\/(\d+)$/.exec(url);
    if (asset) return new Response(null, { status: 302, headers: { location: objectUrl(asset[1]) } });
    const object = /^https:\/\/objects\.githubusercontent\.com\/github-production-release-asset\/(\d+)\?sig=signed$/.exec(url);
    if (object && assets.has(Number(object[1]))) return new Response(assets.get(Number(object[1])));
    throw new TypeError(`unexpected request ${url}`);
  };
  return { fetch, calls, assetCalls: () => calls.filter(call => call.url.includes('/releases/assets/')).length };
}
const serve = (...releases) => github({ list: releases.map(release => listed(release)), releases });

async function fixture(run) {
  const database = await sourceDatabase();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sd-release-import-'));
  const storage = createStorage({ OBJECT_STORAGE_DRIVER: 'filesystem', OBJECT_STORAGE_PATH: path.join(directory, 'objects') });
  let time = Date.UTC(2026, 10, 3, 12);
  const clock = () => time;
  const check = (gh, options = {}) => runReleaseCheck(database, { trigger: 'maintenance', storage, fetch: gh.fetch, clock, timers: fakeTimers(), log: () => {}, publicKeyPem, ...options });
  const importRow = tag => database.one(sql`SELECT source,version,status,reason,release_id,fingerprint,attempted_at FROM agent_release_imports WHERE tag=${tag}`);
  const count = async table => Number((await database.one(sql`SELECT count(*) AS n FROM ${sql.ident(table)}`)).n);
  const source = () => database.one(sql`SELECT lease_holder,lease_until,requested_at,last_started_at,last_finished_at,last_status,last_error FROM agent_release_source WHERE id=1`);
  try {
    await run({ database, storage, directory, check, importRow, count, source, clock, tick: (ms = 1000) => { time += ms; return time; } });
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

// The catalog and the download route with the test publisher and this storage.
function libraries(storage) {
  const load = sourceLoader();
  const server = {
    HttpError, now: () => Date.now(), config: key => key === 'SITE_ORIGIN' ? origin : '',
    failure: error => Response.json({ code: error.code, messageKey: error.messageKey }, { status: error.status ?? 500 }),
  };
  const imports = {
    // JSON modules as the transpiled default import reads them.
    '../context': server,'./context':server, '@/lib/server/context': server, '../../release-publisher.json': { default: { publicKey: publicKeyPem } },
    'cloudflare:workers': { env: { BUCKET: storage } },
  };
  return { releases: load('lib/server/agent/releases.ts', imports), route: load('app/downloads/[file]/route.ts', imports) };
}

test('only published agent-vX.Y.Z releases count, the 3 highest, with exact URLs and headers and no other host', () => fixture(async ({ check, importRow, count }) => {
  const releases = ['4.10.0', '4.9.0', '4.12.1', '4.11.0'].map(version => buildRelease(version)), extra = buildRelease('4.13.0');
  const gh = github({
    releases: [...releases, extra],
    list: [...releases.map(release => listed(release)), listed(extra, { draft: true }), listed(extra, { prerelease: true }), listed(extra, { tag: 'v4.13.0' }), listed(extra, { tag: 'agent-v4.13' }), listed(extra, { tag: 'agent-v4.13.0-beta' })],
  });
  assert.deepEqual(await check(gh), { status: 'ok', imported: 3, present: 0, failed: 0, removedChunks: 0 });
  assert.deepEqual((await Promise.all(['4.12.1', '4.11.0', '4.10.0', '4.9.0', '4.13.0'].map(version => importRow(`agent-v${version}`)))).map(row => row?.status ?? null), ['imported', 'imported', 'imported', null, null], 'the 3 highest; older, draft, prerelease and other tags are ignored');
  assert.equal(await count('agent_releases'), 3);
  assert.deepEqual(gh.calls[0], { url: releaseListUrl, redirect: 'manual', headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': `ServerDesk/${portalVersion}` } });
  assert.equal(releaseListUrl, 'https://api.github.com/repos/nodiverna/nodiverna/releases?per_page=100');
  for (const call of gh.calls) {
    assert.ok(call.url === releaseListUrl || /^https:\/\/api\.github\.com\/repos\/nodiverna\/nodiverna\/releases\/assets\/\d+$/.test(call.url) || call.url.startsWith('https://objects.githubusercontent.com/'), call.url);
    assert.deepEqual(Object.keys(call.headers).sort(), ['Accept', 'User-Agent', 'X-GitHub-Api-Version'], 'no token and nothing about the instance or the fleet');
    if (call.url !== releaseListUrl) assert.equal(call.headers.Accept, 'application/octet-stream');
  }
  // 5 assets of 3 releases, each through the API endpoint and one redirect.
  assert.equal(gh.assetCalls(), 15);
}));

test('no request (list, asset, redirect hop) carries an Authorization header; bad redirects and too many hops fail the release', () => fixture(async ({ check, importRow }) => {
  assert.deepEqual(['releaseTokenContext', 'releaseTokenPattern'].filter(name => name in releaseImport), [], 'the importer exports no token context or pattern');
  const good = buildRelease('4.12.1'), evil = buildRelease('4.12.0'), plain = buildRelease('4.11.0');
  const gh = github({
    releases: [good, evil, plain], list: [good, evil, plain].map(release => listed(release)),
    routes: {
      [releaseAssetUrl(evil.ids.record)]: () => new Response(null, { status: 302, headers: { location: 'https://evil.example/asset' } }),
      [releaseAssetUrl(plain.ids.record)]: () => new Response(null, { status: 302, headers: { location: 'http://objects.githubusercontent.com/asset' } }),
    },
  });
  assert.deepEqual(await check(gh), { status: 'ok', imported: 1, present: 0, failed: 2, removedChunks: 0 });
  assert.deepEqual([(await importRow(evil.tag)).reason, (await importRow(plain.tag)).reason], ['invalidResponse', 'invalidResponse']);
  assert.ok(!gh.calls.some(call => call.url.startsWith('https://evil.example') || call.url.startsWith('http:')), 'a refused target is never requested');
  assert.ok(gh.calls.some(call => call.url === releaseListUrl) && gh.calls.some(call => call.url.includes('/releases/assets/')) && gh.calls.some(call => call.url.startsWith('https://objects.githubusercontent.com/')), 'the list, the asset endpoints and the redirect targets were requested');
  for (const call of gh.calls) assert.equal(Object.keys(call.headers).some(name => name.toLowerCase() === 'authorization'), false, `no Authorization header on ${call.url}`);
  // Four redirects: three are followed, the fourth fails the release.
  const hops = buildRelease('4.13.0');
  const chain = Object.fromEntries([1, 2, 3].map(n => [`https://a.githubusercontent.com/hop${n}`, () => new Response(null, { status: 307, headers: { location: `https://a.githubusercontent.com/hop${n + 1}` } })]));
  const long = github({ releases: [hops], list: [listed(hops)], routes: { ...chain, [releaseAssetUrl(hops.ids.record)]: () => new Response(null, { status: 302, headers: { location: 'https://a.githubusercontent.com/hop1' } }) } });
  assert.equal((await check(long)).failed, 1);
  assert.equal((await importRow(hops.tag)).reason, 'invalidResponse');
  assert.deepEqual(long.calls.filter(call => call.url.includes('/hop')).map(call => call.url.slice(-4)), ['hop1', 'hop2', 'hop3'], 'at most 3 hops');
  for (const call of long.calls) assert.equal(Object.keys(call.headers).some(name => name.toLowerCase() === 'authorization'), false, `no Authorization header on ${call.url}`);
}));

test('each list-level failure fails the check with its key and records it', () => fixture(async ({ check, source, tick }) => {
  const big = '[' + ' '.repeat(releaseImport.releaseImportLimits.listBytes) + ']';
  const cases = [
    ['unreachable', () => { throw new TypeError('fetch failed'); }],
    ['timeout', () => { throw new DOMException('The operation timed out.', 'TimeoutError'); }],
    ['rateLimited', () => new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } })],
    ['rateLimited', () => new Response('{}', { status: 429 })],
    ['rateLimited', () => new Response('{}', { status: 403, headers: { 'retry-after': '60' } })],
    ['invalidResponse', () => new Response('{}', { status: 401 })],
    ['notFound', () => new Response('{}', { status: 404 })],
    ['invalidResponse', () => new Response('{}', { status: 500 })],
    ['invalidResponse', () => new Response('{}', { status: 403 })],
    ['invalidResponse', () => new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '12' } })],
    ['invalidResponse', () => new Response('not json')],
    ['invalidResponse', () => new Response('{"releases":[]}')],
    ['invalidResponse', () => new Response(big)],
  ];
  for (const [reason, list] of cases) {
    const started = tick();
    assert.deepEqual(await check(github({ list })), { status: 'failed', imported: 0, present: 0, failed: 0, removedChunks: 0 }, reason);
    assert.deepEqual(await source(), { lease_holder: null, lease_until: null, requested_at: null, last_started_at: started, last_finished_at: started, last_status: 'failed', last_error: `serverMessage.releaseImport.${reason}` }, reason);
  }
  const started = tick();
  assert.deepEqual(await check(github({ list: [] })), { status: 'ok', imported: 0, present: 0, failed: 0, removedChunks: 0 });
  assert.deepEqual([(await source()).last_status, (await source()).last_error, (await source()).last_started_at], ['ok', null, started], 'an ok check clears the error');
}));

test('missing or oversized assets and invalid records fail before the big downloads', () => fixture(async ({ check, importRow, count }) => {
  const missing = buildRelease('4.12.9'), starter = buildRelease('4.12.8'), oversized = buildRelease('4.12.7');
  let gh = github({ releases: [missing, starter, oversized], list: [listed(missing, { omit: ['signature'] }), listed(starter, { state: { exe: 'starter' } }), listed(oversized, { sizes: { record: 16 * 1024 + 1 } })] });
  assert.deepEqual(await check(gh), { status: 'ok', imported: 0, present: 0, failed: 3, removedChunks: 0 });
  assert.deepEqual([(await importRow(missing.tag)).reason, (await importRow(starter.tag)).reason, (await importRow(oversized.tag)).reason], ['assetsMissing', 'assetsMissing', 'tooLarge']);
  assert.equal(gh.assetCalls(), 0, 'nothing is downloaded');
  for (const [index, [kind, limit]] of [['manifest', 8192], ['signature', 256], ['zip', 104857600], ['exe', 250000000]].entries()) {
    const release = buildRelease(`4.11.${index + 1}`);
    gh = github({ releases: [release], list: [listed(release, { sizes: { [kind]: limit + 1 } })] });
    assert.equal((await check(gh)).failed, 1, kind);
    assert.equal((await importRow(release.tag)).reason, 'tooLarge', kind);
    assert.equal(gh.assetCalls(), 0, kind);
  }
  const foreignKey = buildRelease('4.10.1', { key: foreign.privateKey });
  const absolute = buildRelease('4.10.2', { edit: manifest => { const { path: zipPath, ...rest } = manifest, { path: exePath, ...exe } = manifest.exe; return { ...rest, url: origin + zipPath, exe: { ...exe, url: origin + exePath } }; } });
  const wrongName = buildRelease('4.10.3', { edit: manifest => ({ ...manifest, path: '/downloads/agent.zip' }) });
  const mismatch = buildRelease('4.10.4');
  for (const [release, reason, bytes] of [[foreignKey, 'signatureInvalid'], [absolute, 'manifestInvalid'], [wrongName, 'manifestInvalid'], [mismatch, 'manifestInvalid', { [mismatch.ids.manifest]: Buffer.concat([mismatch.files.manifest, Buffer.from('\n')]) }]]) {
    gh = github({ releases: [release], list: [listed(release)], bytes });
    assert.equal((await check(gh)).failed, 1, release.version);
    assert.equal((await importRow(release.tag)).reason, reason, release.version);
    assert.ok(!gh.calls.some(call => call.url === objectUrl(release.ids.zip) || call.url === objectUrl(release.ids.exe)), `${release.version}: no ZIP or EXE download`);
  }
  assert.equal(await count('agent_releases'), 0);
}));

test('an import stores chunks under their hashes, writes the rows in one go and serves exactly the signed bytes', () => fixture(async ({ database, storage, check, importRow, count, clock }) => {
  const exe = Buffer.alloc(agentReleasePartSize + 1000);
  for (let index = 0; index < exe.length; index += 4096) exe[index] = index % 251;
  const release = buildRelease('4.12.1', { exe });
  // A chunk that exists with the same size is not written again.
  await storage.put(releaseChunkKey(hash(release.files.zip)), release.files.zip);
  const puts = [], counting = { ...storage, put: async (key, value, options) => { puts.push(key); return storage.put(key, value, options); } };
  assert.deepEqual(await check(serve(release), { storage: counting }), { status: 'ok', imported: 1, present: 0, failed: 0, removedChunks: 0 });
  const chunks = [release.files.zip, exe.subarray(0, agentReleasePartSize), exe.subarray(agentReleasePartSize)].map(bytes => ({ sha256: hash(bytes), size: bytes.length }));
  assert.deepEqual(puts, [releaseChunkKey(chunks[1].sha256), releaseChunkKey(chunks[2].sha256)], 'the existing ZIP chunk is not rewritten');
  for (const chunk of chunks) {
    const object = await storage.get(releaseChunkKey(chunk.sha256));
    const bytes = Buffer.from(await object.arrayBuffer());
    assert.deepEqual([hash(bytes), bytes.length], [chunk.sha256, chunk.size], 'the key is the SHA-256 of the chunk');
  }
  assert.deepEqual(await database.one(sql`SELECT id,version,manifest,signature,sha256,size,created_at FROM agent_releases`), { id: release.record.id, version: '4.12.1', manifest: release.record.manifest, signature: release.record.signature, sha256: release.record.sha256, size: release.record.size, created_at: clock() }, 'the exact signed bytes, created at the import time');
  const files = await database.query(sql`SELECT release_id,path,size,sha256,chunks FROM agent_release_files ORDER BY path`);
  const names = release.names;
  assert.deepEqual(files.map(row => ({ ...row, chunks: JSON.parse(row.chunks) })), [
    { release_id: release.record.id, path: `/downloads/${names.exe}`, size: exe.length, sha256: hash(exe), chunks: [chunks[1], chunks[2]] },
    { release_id: release.record.id, path: `/downloads/${names.exe}.part1`, size: chunks[1].size, sha256: chunks[1].sha256, chunks: [chunks[1]] },
    { release_id: release.record.id, path: `/downloads/${names.exe}.part2`, size: chunks[2].size, sha256: chunks[2].sha256, chunks: [chunks[2]] },
    { release_id: release.record.id, path: `/downloads/${names.zip}`, size: release.files.zip.length, sha256: hash(release.files.zip), chunks: [chunks[0]] },
  ]);
  const fingerprint = JSON.stringify(kinds.map(kind => [release.ids[kind], release.files[kind].length, '2026-11-01T00:00:00Z']));
  assert.deepEqual(await importRow(release.tag), { source: 'github', version: '4.12.1', status: 'imported', reason: null, release_id: release.record.id, fingerprint, attempted_at: clock() });
  assert.deepEqual(await database.query(sql`SELECT actor,action,target,server_id,scope FROM audit`), [{ actor: 'System', action: 'Agent release imported from GitHub', target: '4.12.1', server_id: null, scope: 'portal' }]);
  assert.equal(await count('jobs'), 0, 'no job and no other device-facing change');

  // The catalog accepts the stored row (verifiedRelease) in the path form.
  const { releases, route } = libraries(storage);
  const entry = (await releases.releases()).find(item => item.id === release.record.id);
  assert.deepEqual([entry?.version, 'legacyForm' in (entry ?? {}), entry?.active, entry?.latest], ['4.12.1', false, true, true]);
  const envelopes = await releases.releaseEnvelopes(release.record.id);
  assert.deepEqual([envelopes.path?.manifest, 'absolute' in envelopes], [release.record.manifest, false], 'deploy sends the path envelope; there is no absolute form');

  // GET /downloads/<file>: the whole files and each part give exactly the signed bytes.
  const get = file => route.GET(new Request(`${origin}/downloads/${file}`), { params: Promise.resolve({ file }) });
  for (const [file, bytes] of [[names.zip, release.files.zip], [names.exe, exe], [`${names.exe}.part1`, exe.subarray(0, agentReleasePartSize)], [`${names.exe}.part2`, exe.subarray(agentReleasePartSize)]]) {
    const response = await get(file);
    assert.equal(response.status, 200, file);
    assert.deepEqual(Object.fromEntries(['content-type', 'content-length', 'cache-control', 'x-content-type-options'].map(name => [name, response.headers.get(name)])), { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }, file);
    assert.ok(Buffer.from(await response.arrayBuffer()).equals(bytes), file);
  }
  const unknown = await get('ServerDesk-Agent-9.9.9-win-x64.exe');
  assert.deepEqual([unknown.status, (await unknown.json()).messageKey], [404, 'apiError.download.fileNotFound']);
  // A disabled release still serves dispatched updates; a deleted one does not.
  await database.exec(sql`INSERT INTO agent_release_states VALUES(${release.record.id},'disabled',1,'owner')`);
  assert.equal((await get(names.zip)).status, 200);
  await database.exec(sql`UPDATE agent_release_states SET state='deleted' WHERE release_id=${release.record.id}`);
  assert.equal((await get(names.zip)).status, 404);
  await database.exec(sql`DELETE FROM agent_release_states`);
  // A changed chunk of the same length aborts the response.
  const corrupt = Buffer.from(release.files.zip);
  corrupt[0] ^= 1;
  await storage.put(releaseChunkKey(chunks[0].sha256), corrupt);
  await assert.rejects((await get(names.zip)).arrayBuffer());
  await storage.delete(releaseChunkKey(chunks[2].sha256));
  await assert.rejects(streamReleaseFile(storage, files[0]).arrayBuffer(), /missing/);
}));

/**
 * The storage of the fixture that records each get and put, reports every
 * object as written at `uploaded()`, and fails the reads or writes `fail` names.
 */
function spied(storage, uploaded, fail = {}) {
  const gets = [], puts = [];
  return {
    gets, puts, list: (...args) => storage.list(...args), delete: (...args) => storage.delete(...args),
    async head(key) { const object = await storage.head(key); return object ? { ...object, uploaded: new Date(uploaded()) } : object; },
    async get(key, options) {
      gets.push(key);
      if (fail.get?.(key)) throw new Error('the storage is not reachable');
      if (fail.getNull?.(key)) return null;
      const object = await storage.get(key, options);
      if (!fail.readThrows?.(key) || !object) return object;
      await object.body.cancel();
      return { ...object, body: new ReadableStream({ pull(controller) { controller.error(new Error('the read broke')); } }) };
    },
    async put(key, value, options) {
      puts.push(key);
      if (fail.put?.(key)) throw new Error('the storage refused the write');
      const stored = await storage.put(key, value, options);
      return fail.short?.(key) ? { ...stored, size: stored.size - 1 } : stored;
    },
  };
}

test('a recent chunk of the same size is reused only when its stored bytes hash to its key; any other one is written again', () => fixture(async ({ database, storage, check, importRow, clock }) => {
  const release = buildRelease('4.12.1');
  const zipKey = releaseChunkKey(hash(release.files.zip)), exeKey = releaseChunkKey(hash(release.files.exe));
  // Same key, same size, written now, other bytes: corrupt. The EXE chunk is correct.
  const corrupt = Buffer.from(release.files.zip);
  corrupt[0] ^= 1;
  await storage.put(zipKey, corrupt);
  await storage.put(exeKey, release.files.exe);
  const spy = spied(storage, clock);
  assert.deepEqual(await check(serve(release), { storage: spy }), { status: 'ok', imported: 1, present: 0, failed: 0, removedChunks: 0 });
  assert.deepEqual(spy.puts, [zipKey], 'only the corrupt chunk is written again; the correct recent chunk gets no put');
  assert.deepEqual(spy.gets, [zipKey, exeKey], 'both reuse candidates are read and hashed');
  assert.ok(Buffer.from(await (await storage.get(zipKey)).arrayBuffer()).equals(release.files.zip), 'the stored object has the correct bytes');
  const { route } = libraries(storage);
  const response = await route.GET(new Request(`${origin}/downloads/${release.names.zip}`), { params: Promise.resolve({ file: release.names.zip }) });
  assert.equal(response.status, 200);
  assert.ok(Buffer.from(await response.arrayBuffer()).equals(release.files.zip), 'the download gives the exact bytes');
  const file = await database.one(sql`SELECT size,chunks FROM agent_release_files WHERE path=${`/downloads/${release.names.zip}`}`);
  assert.ok(Buffer.from(await streamReleaseFile(storage, file).arrayBuffer()).equals(release.files.zip), 'streamReleaseFile gives the exact bytes');
  assert.equal((await importRow(release.tag)).status, 'imported');

  // get throws, get gives null, the read throws: each chunk is written again and the import succeeds.
  for (const [index, [name, fail]] of [['get throws', { get: () => true }], ['get gives null', { getNull: () => true }], ['the read throws', { readThrows: () => true }]].entries()) {
    const next = buildRelease(`4.13.${index}`);
    const keys = [releaseChunkKey(hash(next.files.zip)), releaseChunkKey(hash(next.files.exe))];
    await storage.put(keys[0], next.files.zip);
    await storage.put(keys[1], next.files.exe);
    const failing = spied(storage, clock, fail);
    assert.equal((await check(serve(next), { storage: failing })).imported, 1, name);
    assert.deepEqual(failing.puts, keys, `${name}: both chunks are written again`);
    for (const [key, bytes] of [[keys[0], next.files.zip], [keys[1], next.files.exe]]) assert.ok(Buffer.from(await (await storage.get(key)).arrayBuffer()).equals(bytes), name);
  }

  // Another size, or older than one hour: written again without a read.
  const sized = buildRelease('4.14.0'), sizedKeys = [releaseChunkKey(hash(sized.files.zip)), releaseChunkKey(hash(sized.files.exe))];
  await storage.put(sizedKeys[0], Buffer.concat([sized.files.zip, Buffer.from('x')]));
  await storage.put(sizedKeys[1], sized.files.exe);
  const old = spied(storage, () => clock() - 60 * 60_000);
  assert.equal((await check(serve(sized), { storage: old })).imported, 1);
  assert.deepEqual([old.gets, old.puts], [[], sizedKeys], 'another size or an old object is written again without a read');

  // A failing put, or a put with the wrong size, still gives storageFailed.
  for (const [index, [name, fail]] of [['put throws', { put: () => true }], ['put has the wrong size', { short: () => true }]].entries()) {
    const next = buildRelease(`4.15.${index}`);
    const broken = spied(storage, clock, fail);
    assert.equal((await check(serve(next), { storage: broken })).failed, 1, name);
    assert.equal((await importRow(next.tag)).reason, 'storageFailed', name);
  }
}));

test('a check that lost its lease writes no present or failed import row and is skipped; a folder import still writes present', () => fixture(async ({ database, storage, directory, check, importRow, count, tick }) => {
  // A fetch that hands the lease to another holder just before the signature of `release` is downloaded.
  const stealing = (gh, release) => ({ ...gh, fetch: async (url, init) => {
    if (url === releaseAssetUrl(release.ids.signature)) await database.exec(sql`UPDATE agent_release_source SET lease_holder='another-check'`);
    return gh.fetch(url, init);
  } });
  const known = buildRelease('4.12.4');
  assert.equal((await check(serve(known))).imported, 1);
  const before = await importRow(known.tag);
  // New assets (another update time) give a new fingerprint: the release is checked again and is present.
  tick();
  const relisted = () => github({ releases: [known], list: [listed(known, { updatedAt: '2026-11-02T00:00:00Z' })] });
  assert.deepEqual(await check(stealing(relisted(), known)), { status: 'skipped' }, 'present: the lost lease skips the check');
  assert.deepEqual(await importRow(known.tag), before, 'the present import row is not written');
  // A release that fails (a foreign signature) under a lost lease.
  await database.exec(sql`UPDATE agent_release_source SET lease_holder=NULL,lease_until=NULL`);
  const bad = buildRelease('4.12.6', { key: foreign.privateKey });
  tick();
  assert.deepEqual(await check(stealing(serve(bad), bad)), { status: 'skipped' }, 'failed: the lost lease skips the check');
  assert.equal(await importRow(bad.tag), null, 'the failed import row is not written');
  assert.equal(await count('agent_release_imports'), 1);
  // Under its own lease the same releases write their rows.
  await database.exec(sql`UPDATE agent_release_source SET lease_holder=NULL,lease_until=NULL`);
  tick();
  assert.deepEqual(await check(github({ releases: [known, bad], list: [listed(known, { updatedAt: '2026-11-02T00:00:00Z' }), listed(bad)] })), { status: 'ok', imported: 0, present: 1, failed: 1, removedChunks: 0 });
  assert.deepEqual([(await importRow(known.tag)).status, (await importRow(bad.tag)).reason], ['present', 'signatureInvalid']);
  // A folder import has no lease: it writes present as before, whoever holds the lease.
  await database.exec(sql`UPDATE agent_release_source SET lease_holder='another-check'`);
  const folder = path.join(directory, 'present');
  await mkdir(folder);
  for (const kind of kinds) await writeFile(path.join(folder, known.names[kind]), known.files[kind]);
  assert.deepEqual(await importRelease(database, { directory: folder, storage, publicKeyPem }), { version: '4.12.4', releaseId: known.record.id, status: 'present' });
  assert.deepEqual([(await importRow(known.tag)).source, (await importRow(known.tag)).status], ['folder', 'present']);
}));

test('a changed byte or a part that is not its slice gives hashMismatch and no rows', () => fixture(async ({ check, importRow, count }) => {
  const changed = buildRelease('4.12.2');
  const zip = Buffer.from(changed.files.zip);
  zip[3] ^= 0x20;
  let gh = github({ releases: [changed], list: [listed(changed)], bytes: { [changed.ids.zip]: zip } });
  assert.equal((await check(gh)).failed, 1);
  assert.equal((await importRow(changed.tag)).reason, 'hashMismatch');
  const exe = Buffer.alloc(agentReleasePartSize + 10);
  for (let index = 0; index < exe.length; index++) exe[index] = index % 253;
  const shifted = buildRelease('4.12.3', { exe, edit: manifest => ({ ...manifest, exe: { ...manifest.exe, parts: [{ ...manifest.exe.parts[0], sha256: hash(exe.subarray(1, agentReleasePartSize + 1)) }, manifest.exe.parts[1]] } }) });
  gh = serve(shifted);
  assert.equal((await check(gh)).failed, 1);
  assert.equal((await importRow(shifted.tag)).reason, 'hashMismatch');
  assert.deepEqual([await count('agent_releases'), await count('agent_release_files'), await count('audit')], [0, 0, 0]);
}));

test('the same id and bytes are present (a deleted release stays deleted); version and path conflicts fail before any download', () => fixture(async ({ database, check, importRow, count }) => {
  const known = buildRelease('4.12.4');
  await database.exec(sql`INSERT INTO agent_releases(id,version,manifest,signature,sha256,size,created_at) VALUES(${known.record.id},${known.version},${known.record.manifest},${known.record.signature},${known.record.sha256},${known.record.size},5)`);
  await database.exec(sql`INSERT INTO agent_release_states VALUES(${known.record.id},'deleted',1,'owner')`);
  let gh = serve(known);
  assert.deepEqual(await check(gh), { status: 'ok', imported: 0, present: 1, failed: 0, removedChunks: 0 });
  assert.deepEqual([(await importRow(known.tag)).status, (await importRow(known.tag)).release_id], ['present', known.record.id]);
  assert.equal((await database.one(sql`SELECT state FROM agent_release_states WHERE release_id=${known.record.id}`)).state, 'deleted', 'a deleted release stays deleted');
  assert.equal(gh.calls.filter(call => call.url === objectUrl(known.ids.zip) || call.url === objectUrl(known.ids.exe)).length, 0, 'nothing is downloaded');
  // The same id with other bytes, another id with this version: versionConflict.
  const sameId = buildRelease('4.12.5', { id: known.record.id }), sameVersion = buildRelease('4.12.4');
  gh = serve(sameId);
  await check(gh);
  assert.equal((await importRow(sameId.tag)).reason, 'versionConflict');
  await database.exec(sql`DELETE FROM agent_release_imports`);
  gh = serve(sameVersion);
  await check(gh);
  assert.equal((await importRow(sameVersion.tag)).reason, 'versionConflict');
  // Only stored releases count: there is no built-in or archived catalog, and
  // no file outside the stored releases can shadow a path (no public/downloads).
  // Another stored release with other content under a path: pathConflict.
  const other = buildRelease('4.12.8');
  await database.exec(sql`INSERT INTO agent_releases(id,version,manifest,signature,sha256,size,created_at) VALUES(${'other-' + other.record.id},'4.0.9',${other.record.manifest},${other.record.signature},${other.record.sha256},${other.record.size},5)`);
  await database.exec(sql`INSERT INTO agent_release_files(release_id,path,size,sha256,chunks) VALUES(${'other-' + other.record.id},${`/downloads/${other.names.zip}`},1,${'f'.repeat(64)},'[]')`);
  await check(serve(other));
  assert.equal((await importRow(other.tag)).reason, 'pathConflict');
  assert.equal(gh.calls.filter(call => call.url === objectUrl(other.ids.zip)).length, 0, 'no download after a path conflict');
  assert.equal(await count('agent_release_files'), 1);
  // The same path with the same content is shared; a path of a deleted release is free.
  const shared = buildRelease('4.12.9');
  await database.exec(sql`INSERT INTO agent_release_files(release_id,path,size,sha256,chunks) VALUES(${'other-' + other.record.id},${`/downloads/${shared.names.zip}`},${shared.files.zip.length},${shared.record.sha256},'[]')`);
  assert.equal((await check(serve(shared))).imported, 1, 'an equal file under the same path is no conflict');
  await database.exec(sql`INSERT INTO agent_release_states VALUES(${'other-' + other.record.id},'deleted',1,'owner')`);
  await database.exec(sql`DELETE FROM agent_release_imports WHERE tag=${other.tag}`);
  assert.equal((await check(serve(other))).imported, 1, 'the path of a deleted release is free');
}));

test('the daily check skips an unchanged permanent failure; Check now and new assets retry; other reasons retry every run', () => fixture(async ({ database, check, importRow, tick }) => {
  const bad = buildRelease('4.12.1', { key: foreign.privateKey }), flaky = buildRelease('4.11.0');
  const gh = github({ releases: [bad, flaky], list: [listed(bad), listed(flaky)], routes: { [objectUrl(flaky.ids.record)]: () => new Response('unavailable', { status: 500 }) } });
  const first = tick();
  assert.deepEqual(await check(gh), { status: 'ok', imported: 0, present: 0, failed: 2, removedChunks: 0 });
  assert.deepEqual([(await importRow(bad.tag)).reason, (await importRow(flaky.tag)).reason], ['signatureInvalid', 'invalidResponse']);
  const downloads = release => gh.calls.filter(call => call.url === releaseAssetUrl(release.ids.record)).length;
  assert.deepEqual([downloads(bad), downloads(flaky)], [1, 1]);
  tick();
  assert.equal((await check(gh)).failed, 2);
  assert.deepEqual([downloads(bad), downloads(flaky), Number((await importRow(bad.tag)).attempted_at)], [1, 2, first], 'the daily run skips the unchanged permanent failure and retries the other reason');
  // Check now (a request newer than the last start) retries every failed release.
  await database.exec(sql`UPDATE agent_release_source SET requested_at=last_started_at+1`);
  tick();
  assert.deepEqual(await check(gh, { trigger: 'request' }), { status: 'ok', imported: 0, present: 0, failed: 2, removedChunks: 0 });
  assert.deepEqual([downloads(bad), downloads(flaky)], [2, 3]);
  assert.deepEqual(await check(gh, { trigger: 'request' }), { status: 'not-requested' }, 'the scheduler checks only on a request');
  // New assets (another update time) give a new fingerprint: the daily run retries.
  const updated = github({ releases: [bad], list: [listed(bad, { updatedAt: '2026-11-02T00:00:00Z' })] });
  tick();
  await check(updated);
  assert.equal(updated.calls.filter(call => call.url === releaseAssetUrl(bad.ids.record)).length, 1);
  // Once the asset answers, the release is imported.
  const healthy = github({ releases: [flaky], list: [listed(flaky)] });
  tick();
  assert.equal((await check(healthy)).imported, 1);
  assert.equal((await importRow(flaky.tag)).status, 'imported');
  // An unchanged success is not downloaded again.
  tick();
  assert.deepEqual(await check(healthy), { status: 'ok', imported: 0, present: 1, failed: 0, removedChunks: 0 });
  assert.equal(healthy.calls.filter(call => call.url === releaseAssetUrl(flaky.ids.record)).length, 1);
}));

test('a check runs only under the lease; a second one during the lease is skipped and writes nothing', () => fixture(async ({ database, storage, check, source, count, clock }) => {
  let open;
  const gate = new Promise(resolve => { open = resolve; });
  const release = buildRelease('4.12.1');
  const slow = github({ releases: [release], list: async () => { await gate; return Response.json([listed(release)]); } });
  const timers = fakeTimers();
  const first = check(slow, { timers });
  for (let n = 0; n < 200 && !(await source()).lease_holder; n++) await new Promise(resolve => setTimeout(resolve, 10));
  const held = await source();
  assert.ok(held.lease_holder && Number(held.lease_until) === Number(held.last_started_at) + 15 * 60_000, 'the lease lasts 15 minutes');
  assert.deepEqual([timers.entries.length, timers.entries[0].ms], [1, 60_000], 'renewed every minute');
  const other = createDatabase({ url: database.url, password: database.password, max: 2 });
  try {
    const second = await runReleaseCheck(other, { storage, fetch: serve(release).fetch, clock, timers: fakeTimers(), log: () => {}, publicKeyPem });
    assert.deepEqual(second, { status: 'skipped' });
    assert.deepEqual(await source(), held, 'the second check writes nothing');
    assert.equal(await count('agent_release_imports'), 0);
    assert.deepEqual(await maintenanceReleaseCheck(other, { storage, fetch: serve(release).fetch, clock, timers: fakeTimers(), publicKeyPem }), { status: 'skipped', removedChunks: 0 }, 'the maintenance step reports skipped and removes nothing');
  } finally { await other.close(); }
  await timers.entries[0].fn();
  open();
  assert.deepEqual(await first, { status: 'ok', imported: 1, present: 0, failed: 0, removedChunks: 0 });
  assert.equal(timers.entries[0].cleared, true);
  const done = await source();
  assert.deepEqual([done.lease_holder, done.lease_until, done.last_status], [null, null, 'ok']);
}));

test('import-release reads one folder offline with the same checks', () => fixture(async ({ database, storage, directory, importRow, count }) => {
  const folder = path.join(directory, 'release');
  await mkdir(folder);
  const release = buildRelease('4.12.5');
  const write = async (item, into = folder) => { for (const kind of kinds) await writeFile(path.join(into, item.names[kind]), item.files[kind]); };
  await write(release);
  await writeFile(path.join(folder, 'notes.md'), 'notes\n');
  const original = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async () => { fetched++; throw new TypeError('offline'); };
  try {
    assert.deepEqual(await importRelease(database, { directory: folder, storage, publicKeyPem }), { version: '4.12.5', releaseId: release.record.id, status: 'imported' });
    assert.deepEqual(await importRelease(database, { directory: folder, storage, publicKeyPem }), { version: '4.12.5', releaseId: release.record.id, status: 'present' }, 'a second import finds it in the catalog');
  } finally { globalThis.fetch = original; }
  assert.equal(fetched, 0, 'no network access');
  assert.deepEqual([(await importRow(release.tag)).source, (await importRow(release.tag)).status], ['folder', 'present']);
  assert.deepEqual(await database.query(sql`SELECT actor,action,target FROM audit`), [{ actor: 'System', action: 'Agent release imported from a folder', target: '4.12.5' }]);
  assert.equal(await count('agent_release_files'), 2);
  // Missing and ambiguous files name the file; a failed check gives the reason in English.
  const broken = path.join(directory, 'broken');
  await mkdir(broken);
  const other = buildRelease('4.12.6');
  await write(other, broken);
  await unlink(path.join(broken, other.names.exe));
  await assert.rejects(importRelease(database, { directory: broken, storage, publicKeyPem }), { message: `The folder ${broken} has no file ServerDesk-Agent-4.12.6-win-x64.exe.` });
  await write(other, broken);
  await writeFile(path.join(broken, 'ServerDesk-Agent-4.12.7-release.json'), '{}');
  await assert.rejects(importRelease(database, { directory: broken, storage, publicKeyPem }), { message: `The folder ${broken} has more than one release record: ServerDesk-Agent-4.12.6-release.json, ServerDesk-Agent-4.12.7-release.json. Keep exactly one release in the folder.` });
  await unlink(path.join(broken, 'ServerDesk-Agent-4.12.7-release.json'));
  await assert.rejects(importRelease(database, { directory: broken, storage }), { message: 'Agent 4.12.6 was not imported: The signature does not match the publisher key of this portal. The release was not imported.' }, 'the pinned key refuses the test publisher');
  assert.deepEqual([(await importRow(other.tag)).source, (await importRow(other.tag)).reason], ['folder', 'signatureInvalid']);
  const empty = await testDatabase({ template: false });
  try {
    await assert.rejects(importRelease(empty, { directory: folder, storage, publicKeyPem }), { message: 'Apply all migrations with the command migrate before import-release.' });
  } finally { await empty.close(); }
  // The CLI: usage, exit code 1 and the English message.
  const cli = args => spawnSync(process.execPath, ['--import', './tests/support/offline-fetch.mjs', 'scripts/selfhost.mjs', ...args], { cwd: projectRoot, encoding: 'utf8', timeout: 60000, env: { ...process.env, DATABASE_URL: database.url, DATABASE_PASSWORD: database.password, OBJECT_STORAGE_DRIVER: 'filesystem', OBJECT_STORAGE_PATH: path.join(directory, 'cli-objects') } });
  assert.match(cli(['--help']).stdout, /selfhost\.mjs import-release <dir>/);
  await unlink(path.join(broken, other.names.signature));
  const failed = cli(['import-release', broken]);
  assert.deepEqual([failed.status, failed.stdout], [1, '']);
  assert.match(failed.stderr, /^ServerDesk: The folder .* has no file ServerDesk-Agent-4\.12\.6-manifest\.sig\.$/m);
  assert.equal(cli(['import-release']).status, 1);
  // import-release has no token option and no token variable: neither the usage nor the header comment names one.
  const usage = cli(['--help']).stdout, header = readFileSync(new URL('../../scripts/selfhost.mjs', import.meta.url), 'utf8').split('*/')[0];
  assert.equal(/token/i.test(usage), false, 'the usage text names no token');
  assert.deepEqual(header.split('\n').filter(line => /token/i.test(line) && /release|github/i.test(line)), [], 'the header comment names no GitHub or release token');
  assert.match(readFileSync(new URL('../../scripts/selfhost.mjs', import.meta.url), 'utf8').split('*/')[0], /selfhost\.mjs import-release <dir>/, 'the header comment lists the command');
}));

test('an asset that GitHub rate limits fails its release with rateLimited; later releases that need a download fail at once without a request; a present release stays present; the next daily check tries again', () => fixture(async ({ check, importRow, tick }) => {
  const known = buildRelease('4.11.0');
  assert.equal((await check(serve(known))).imported, 1);
  const first = buildRelease('4.12.1'), second = buildRelease('4.12.0'), requests = [];
  for (const [label, answer] of [['429', () => new Response('{}', { status: 429 })], ['403 x-ratelimit-remaining 0', () => new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } })]]) {
    const gh = github({ releases: [first, second, known], list: [listed(first), listed(second), listed(known)], routes: { [releaseAssetUrl(first.ids.record)]: answer } });
    tick();
    assert.deepEqual(await check(gh), { status: 'ok', imported: 0, present: 1, failed: 2, removedChunks: 0 }, label);
    assert.deepEqual([(await importRow(first.tag)).reason, (await importRow(second.tag)).reason, (await importRow(known.tag)).status], ['rateLimited', 'rateLimited', 'imported'], `${label}: the unchanged release keeps its row and counts as present`);
    assert.deepEqual(gh.calls.filter(call => call.url.includes('/releases/assets/')).map(call => call.url), [releaseAssetUrl(first.ids.record)], `${label}: after the limit the check sends no more GitHub request`);
    requests.push(gh.calls.length);
  }
  assert.deepEqual(requests, [2, 2], 'one list and one asset request per check');
  // rateLimited is no permanent failure: the next daily check tries both releases again.
  tick();
  const healthy = serve(first, second, known);
  assert.deepEqual(await check(healthy), { status: 'ok', imported: 2, present: 1, failed: 0, removedChunks: 0 });
  assert.deepEqual([(await importRow(first.tag)).status, (await importRow(second.tag)).status], ['imported', 'imported']);
}));

test('the failure reasons and their CLI texts have no token reason; the rate-limit and not-found texts match the catalog', () => {
  assert.equal(releaseImportFailures.includes('tokenRejected'), false);
  assert.equal(Object.hasOwn(releaseImportReasonText, 'tokenRejected'), false);
  assert.deepEqual(Object.keys(releaseImportReasonText).sort(), [...releaseImportFailures].sort(), 'one CLI text per reason');
  assert.equal(releaseImportReasonText.rateLimited, 'GitHub limits the requests from this portal for now. The limit resets within an hour, and the next check tries again.');
  assert.equal(releaseImportReasonText.notFound, 'GitHub did not find the repository nodiverna/nodiverna. The next check tries again.');
  for (const text of Object.values(releaseImportReasonText)) assert.equal(/token|sign in|sign-in/i.test(text), false, text);
});

test('rewrap-secrets on a database with releases does not read agent_release_source and counts no release token', () => fixture(async ({ database, check }) => {
  assert.equal((await check(serve(buildRelease('4.12.1')))).imported, 1);
  const texts = [];
  const recorded = target => new Proxy(target, {
    get(object, key) {
      if (['query', 'one', 'exec'].includes(key)) return statement => { texts.push(compile(statement).text); return object[key](statement); };
      if (key === 'transaction') return fn => object.transaction(tx => fn(recorded(tx)));
      const value = object[key];
      return typeof value === 'function' ? value.bind(object) : value;
    },
  });
  const summary = await rewrapSecrets(recorded(database), { env: { SESSION_SECRET: 'session-secret-for-release-import-tests-0002', SESSION_SECRET_PREVIOUS: secret } });
  assert.deepEqual([summary.checked, summary.rewrapped, summary.unchanged, summary.failed], [0, 0, 0, 0], 'no release token is counted');
  assert.ok(texts.length > 0, 'the statements were recorded');
  assert.deepEqual(texts.filter(text => /agent_release_source/.test(text)), [], 'rewrap-secrets never reads agent_release_source');
}));

// ---- Chunk cleanup ------------------------------------------------------------------
/**
 * The storage of the fixture with chosen upload times (keys in `uploadedAt`),
 * pages of at most `pageSize` objects and optional failures.
 */
function aged(storage, uploadedAt, { pageSize = 2, failList, failDelete } = {}) {
  const lists = [], deleted = [];
  const age = object => object && uploadedAt.has(object.key) ? { ...object, uploaded: new Date(uploadedAt.get(object.key)) } : object;
  return {
    lists, deleted, get: (...args) => storage.get(...args), put: (...args) => storage.put(...args),
    async head(key) { const object = await storage.head(key); return object ? age({ ...object, key }) : object; },
    async list(options) {
      lists.push(options.cursor ?? null);
      if (failList?.(lists.length)) throw new Error('the storage is not reachable');
      const page = await storage.list({ ...options, limit: Math.min(options.limit, pageSize) });
      return { ...page, objects: page.objects.map(age) };
    },
    async delete(key) { if (failDelete) throw new Error('the storage refused the delete'); deleted.push(key); return storage.delete(key); },
  };
}

test('each check deletes only chunks that no release which is not deleted references and that are older than 24 hours, page by page', () => fixture(async ({ database, storage, check, clock, tick }) => {
  const release = buildRelease('4.12.1');
  assert.equal((await check(serve(release))).imported, 1);
  const chunk = text => { const bytes = Buffer.from(text); return { bytes, key: releaseChunkKey(hash(bytes)), sha256: hash(bytes), size: bytes.length }; };
  const orphanOld = chunk('orphan old'), orphanYoung = chunk('orphan young'), shared = chunk('shared with a deleted release'), deletedOnly = chunk('only a deleted release');
  for (const item of [orphanOld, orphanYoung, shared, deletedOnly]) await storage.put(item.key, item.bytes);
  await storage.put('transfers/unrelated', Buffer.from('not a chunk'));
  // Release B (active) and C (deleted) share one chunk; C has one of its own.
  const row = (id, version) => database.exec(sql`INSERT INTO agent_releases(id,version,manifest,signature,sha256,size,created_at) VALUES(${id},${version},'{}','c2ln',${'a'.repeat(64)},1,1)`);
  await row('release-b', '4.0.1'); await row('release-c', '4.0.2');
  await database.exec(sql`INSERT INTO agent_release_states VALUES('release-c','deleted',1,'owner')`);
  const file = (id, name, items) => database.exec(sql`INSERT INTO agent_release_files(release_id,path,size,sha256,chunks) VALUES(${id},${name},${items.reduce((n, item) => n + item.size, 0)},${'b'.repeat(64)},${JSON.stringify(items.map(({ sha256, size }) => ({ sha256, size })))})`);
  await file('release-b', '/downloads/b.exe', [shared]);
  await file('release-c', '/downloads/c.exe', [shared, deletedOnly]);
  const day = 24 * 60 * 60_000, now = clock(), imported = (await database.query(sql`SELECT chunks FROM agent_release_files WHERE release_id=${release.record.id}`)).flatMap(item => JSON.parse(item.chunks)).map(item => releaseChunkKey(item.sha256));
  const uploadedAt = new Map([[orphanOld.key, now - day - 1], [orphanYoung.key, now - 60 * 60_000], [shared.key, now - 3 * day], [deletedOnly.key, now - 2 * day], ['transfers/unrelated', now - 9 * day], ...imported.map(key => [key, now - 5 * day])]);
  const paged = aged(storage, uploadedAt);
  assert.deepEqual(await check(github({ list: [] }), { storage: paged }), { status: 'ok', imported: 0, present: 0, failed: 0, removedChunks: 2 });
  assert.deepEqual(paged.deleted.sort(), [orphanOld.key, deletedOnly.key].sort(), 'the old unreferenced chunk and the chunk of only a deleted release');
  assert.ok(paged.lists.length > 2 && paged.lists.slice(1).every(cursor => typeof cursor === 'string'), 'the cleanup pages through the listing with the cursor');
  for (const key of [orphanYoung.key, shared.key, 'transfers/unrelated', ...imported]) assert.ok(await storage.head(key), `${key} stays`);
  // The imported release still serves its exact bytes.
  const { route } = libraries(storage);
  const response = await route.GET(new Request(`${origin}/downloads/${release.names.exe}`), { params: Promise.resolve({ file: release.names.exe }) });
  assert.ok(Buffer.from(await response.arrayBuffer()).equals(release.files.exe));
  // Once the young chunk is older than 24 hours, the next check removes it.
  tick(day);
  assert.equal((await check(github({ list: [] }), { storage: aged(storage, uploadedAt) })).removedChunks, 1);
  assert.equal(await storage.head(orphanYoung.key), null);
}));

test('a storage error stops the cleanup without failing the check; a failed list still cleans up; a skipped check removes nothing', () => fixture(async ({ database, storage, check, clock }) => {
  const day = 24 * 60 * 60_000, bytes = Buffer.from('an old orphan'), key = releaseChunkKey(hash(bytes)), logs = [];
  await storage.put(key, bytes);
  const uploadedAt = new Map([[key, clock() - 2 * day]]);
  for (const options of [{ failList: () => true }, { failDelete: true }]) {
    const broken = aged(storage, uploadedAt, options);
    assert.deepEqual(await check(github({ list: [] }), { storage: broken, log: message => logs.push(message) }), { status: 'ok', imported: 0, present: 0, failed: 0, removedChunks: 0 }, JSON.stringify(options));
    assert.ok(await storage.head(key), 'nothing was deleted');
  }
  assert.equal(logs.length, 2);
  assert.ok(logs.every(message => message.startsWith('ServerDesk: The cleanup of unused agent release chunks stopped')), logs.join('\n'));
  // A second page that fails stops the cleanup before any delete.
  const another = Buffer.from('another orphan');
  await storage.put(releaseChunkKey(hash(another)), another);
  uploadedAt.set(releaseChunkKey(hash(another)), clock() - 2 * day);
  const halfway = aged(storage, uploadedAt, { pageSize: 1, failList: count => count === 2 });
  assert.equal((await check(github({ list: [] }), { storage: halfway })).removedChunks, 0);
  assert.deepEqual(halfway.deleted, []);
  // GitHub is not reachable: the check fails, the cleanup still runs.
  assert.deepEqual(await check(github({ list: () => { throw new TypeError('fetch failed'); } }), { storage: aged(storage, uploadedAt) }), { status: 'failed', imported: 0, present: 0, failed: 0, removedChunks: 2 });
  // A skipped check (another holder of the lease) removes nothing.
  const kept = Buffer.from('kept while skipped');
  await storage.put(releaseChunkKey(hash(kept)), kept);
  uploadedAt.set(releaseChunkKey(hash(kept)), clock() - 2 * day);
  await database.exec(sql`UPDATE agent_release_source SET lease_holder='other',lease_until=${clock() + 60_000} WHERE id=1`);
  const skipped = aged(storage, uploadedAt);
  assert.deepEqual(await check(github({ list: [] }), { storage: skipped }), { status: 'skipped' });
  assert.deepEqual([skipped.lists.length, skipped.deleted.length], [0, 0]);
  assert.deepEqual(await maintenanceReleaseCheck(database, { storage: skipped, fetch: github({ list: [] }).fetch, clock, timers: fakeTimers(), publicKeyPem }), { status: 'skipped', removedChunks: 0 });
  assert.ok(await storage.head(releaseChunkKey(hash(kept))));
}));

test('an import writes an old existing chunk again, so the 24-hour guard covers a running import', () => fixture(async ({ storage, check, clock }) => {
  const release = buildRelease('4.12.1'), key = releaseChunkKey(hash(release.files.zip));
  await storage.put(key, release.files.zip);
  const puts = [], uploadedAt = new Map([[key, clock() - 2 * 60 * 60_000]]);
  const old = { ...aged(storage, uploadedAt), put: async (name, value, options) => { puts.push(name); return storage.put(name, value, options); } };
  assert.equal((await check(serve(release), { storage: old })).imported, 1);
  assert.ok(puts.includes(key), 'a chunk written more than an hour ago is written again');
}));

test('import-release takes a dev agent folder and a dev plugin folder whatever the dev builds switch says', () => fixture(async ({ database, storage, directory, importRow }) => {
  const { pluginReleaseFiles } = await import('../../runtime/plugin-release-verify.mjs');
  assert.equal((await database.one(sql`SELECT dev_builds FROM agent_release_source WHERE id=1`)).dev_builds, false, 'the switch is off');
  const agentFolder = path.join(directory, 'dev-agent');
  await mkdir(agentFolder);
  const dev = buildRelease('4.12.8-dev.abc1234');
  for (const kind of kinds) await writeFile(path.join(agentFolder, dev.names[kind]), dev.files[kind]);
  assert.deepEqual(await importRelease(database, { directory: agentFolder, storage, publicKeyPem }), { version: '4.12.8-dev.abc1234', releaseId: dev.record.id, status: 'imported' });
  assert.deepEqual([(await importRow(dev.tag)).source, (await importRow(dev.tag)).status, dev.tag], ['folder', 'imported', 'agent-v4.12.8-dev.abc1234']);
  // A plugin dev build: the same checks, the import row with source folder.
  const pluginFolder = path.join(directory, 'dev-plugin');
  await mkdir(pluginFolder);
  const version = '1.0.4-dev.abc1234', names = pluginReleaseFiles('dns', version), exe = Buffer.from('exe of the dns dev build');
  const manifest = JSON.stringify({ kind: 'plugin', name: 'dns', target: 'dns', role: 'dns', version, minAgentVersion: '4.21.2', protocolVersion: 1, os: ['Windows Server 2022'], arch: 'x64', capabilities: ['dns-read'],
    exe: { path: `/downloads/${names.exe}`, sha256: hash(exe), size: exe.length }, changelog: { features: ['Dev build from commit abc1234.'], fixes: [] }, createdAt: '2026-11-20T00:00:00.000Z' });
  const signature = sign('sha256', Buffer.from(manifest), publisher.privateKey).toString('base64');
  const record = { id: randomUUID(), name: 'dns', version, manifest, signature, sha256: hash(exe), size: exe.length, createdAt: Date.UTC(2026, 10, 20) };
  await writeFile(path.join(pluginFolder, names.exe), exe);
  await writeFile(path.join(pluginFolder, names.record), JSON.stringify(record, null, 2) + '\n');
  await writeFile(path.join(pluginFolder, names.manifest), manifest);
  await writeFile(path.join(pluginFolder, names.signature), signature);
  assert.deepEqual(await importRelease(database, { directory: pluginFolder, storage, publicKeyPem }), { kind: 'plugin', name: 'dns', version, releaseId: record.id, status: 'imported' });
  assert.deepEqual([(await importRow('plugin-dns-v1.0.4-dev.abc1234')).source, (await importRow('plugin-dns-v1.0.4-dev.abc1234')).status], ['folder', 'imported']);
  // A malformed dev suffix is no release record of a folder.
  const bad = path.join(directory, 'bad-dev');
  await mkdir(bad);
  await writeFile(path.join(bad, 'ServerDesk-Agent-4.12.8-dev.ABC1234-release.json'), '{}');
  await assert.rejects(importRelease(database, { directory: bad, storage, publicKeyPem }), { message: `The folder ${bad} has no ServerDesk-Agent-X.Y.Z-release.json and no ServerDesk-Plugin-<name>-X.Y.Z-release.json.` });
}));
