// Plugin releases from GitHub and folders (runtime/release-import.mjs,
// docs/agent-plugins.md) on PostgreSQL: a fake fetch serves the GitHub list and
// the assets, a throwaway P-256 publisher stands for the pinned key and the
// files go to filesystem storage in a temp folder. No request leaves this process.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sql } from '../../runtime/database.mjs';
import { pluginReleaseFiles, pluginReleasePartSize } from '../../runtime/plugin-release-verify.mjs';
import { pluginImportAuditActions, releaseChunkKey, releaseImportFailures, releaseImportReasonText, releaseListUrl, runReleaseCheck } from '../../runtime/release-import.mjs';
import { createStorage } from '../../runtime/storage.mjs';
import { importRelease } from '../../scripts/selfhost.mjs';
import { sourceDatabase, sourceLoader } from '../support/source-database.mjs';
import { HttpError } from '../support/http-error.mjs';

const publisher = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), foreign = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const publicKeyPem = publisher.publicKey.export({ type: 'spki', format: 'pem' });
const origin = 'https://portal.test';
const kinds = ['exe', 'record', 'manifest', 'signature'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const timers = { setInterval: () => ({ unref() { return this; } }), clearInterval() {} };
let nextAssetId = 5000;

/** A signed plugin release with its four assets. */
function buildPlugin(name, version, { exe = Buffer.from(`exe of the plugin ${name} ${version}`), key = publisher.privateKey, id = randomUUID() } = {}) {
  const names = pluginReleaseFiles(name, version), base = `/downloads/${names.exe}`;
  const parts = exe.length > pluginReleasePartSize ? Array.from({ length: Math.ceil(exe.length / pluginReleasePartSize) }, (_, index) => { const slice = exe.subarray(index * pluginReleasePartSize, (index + 1) * pluginReleasePartSize); return { path: `${base}.part${index + 1}`, sha256: hash(slice), size: slice.length }; }) : undefined;
  const manifest = { kind: 'plugin', name, role: name === 'dns' ? 'dns' : 'dhcp', version, minAgentVersion: '4.16.0', protocolVersion: 1, os: ['Windows Server 2022'], arch: 'x64', capabilities: [`${name}-read`], exe: { path: base, sha256: hash(exe), size: exe.length, ...(parts ? { parts } : {}) }, changelog: { features: ['Imported from GitHub'], fixes: [] }, createdAt: '2026-11-01T00:00:00.000Z' };
  const text = JSON.stringify(manifest), signature = sign('sha256', Buffer.from(text), key).toString('base64');
  const record = { id, name, version, manifest: text, signature, sha256: manifest.exe.sha256, size: manifest.exe.size, createdAt: Date.UTC(2026, 10, 1) };
  const files = { exe, record: Buffer.from(JSON.stringify(record, null, 2) + '\n'), manifest: Buffer.from(text), signature: Buffer.from(signature) };
  return { name, version, tag: `plugin-${name}-v${version}`, names, record, manifest, files, ids: Object.fromEntries(kinds.map(kind => [kind, ++nextAssetId])) };
}
const listed = (release, { omit = [] } = {}) => ({ tag_name: release.tag, draft: false, prerelease: false, assets: kinds.filter(kind => !omit.includes(kind)).map(kind => ({ id: release.ids[kind], name: release.names[kind], state: 'uploaded', size: release.files[kind].length, updated_at: '2026-11-01T00:00:00Z' })) });
function github(list, releases) {
  const assets = new Map();
  for (const release of releases) for (const kind of kinds) assets.set(release.ids[kind], release.files[kind]);
  return async url => {
    if (url === releaseListUrl) return Response.json(list);
    const asset = /\/releases\/assets\/(\d+)$/.exec(url);
    if (asset && assets.has(Number(asset[1]))) return new Response(assets.get(Number(asset[1])));
    throw new TypeError(`unexpected request ${url}`);
  };
}
const noAssets = { fetch: async () => new Response(null, { status: 404 }) };

async function fixture(run) {
  const database = await sourceDatabase(), directory = await mkdtemp(path.join(os.tmpdir(), 'sd-plugin-import-'));
  const storage = createStorage({ OBJECT_STORAGE_DRIVER: 'filesystem', OBJECT_STORAGE_PATH: path.join(directory, 'objects') });
  let time = Date.UTC(2026, 10, 4, 12);
  const check = (list, releases, options = {}) => runReleaseCheck(database, { trigger: 'maintenance', storage, fetch: github(list, releases), env: {}, clock: () => time++, timers, log: () => {}, publicKeyPem, ...options });
  const later = ms => { time += ms; };
  const count = async table => Number((await database.one(sql`SELECT count(*) AS n FROM ${sql.ident(table)}`)).n);
  try { await run({ database, storage, directory, check, count, later }); } finally { await database.close(); await rm(directory, { recursive: true, force: true }); }
}
function routes(storage) {
  const load = sourceLoader();
  const server = { HttpError, now: () => Date.now(), config: key => key === 'SITE_ORIGIN' ? origin : '', failure: error => Response.json({ code: error.code, messageKey: error.messageKey }, { status: error.status ?? 500 }) };
  const imports = { '../context': server,'./context':server, '@/lib/server/context': server, '../../release-publisher.json': { default: { publicKey: publicKeyPem } }, 'cloudflare:workers': { env: { BUCKET: storage, ASSETS: noAssets } } };
  return load('app/downloads/[file]/route.ts', imports);
}

test('plugin tags are picked, three highest versions per name, stored as chunks with their rows', () => fixture(async ({ database, storage, check, count, later }) => {
  const dhcp = ['1.0.0', '1.2.0', '1.1.0', '0.9.0'].map(version => buildPlugin('dhcp', version)), dns = buildPlugin('dns', '1.0.0');
  const decoy = buildPlugin('dhcp', '2.0.0');
  const list = [...dhcp.map(release => listed(release)), listed(dns), { ...listed(decoy), draft: true }, { ...listed(decoy), tag_name: 'plugin-DHCP-v2.0.0' }, { ...listed(decoy), tag_name: 'plugin-dhcp-v2.0' }];
  assert.deepEqual(await check(list, [...dhcp, dns, decoy]), { status: 'ok', imported: 4, present: 0, failed: 0, removedChunks: 0 });
  const stored = await database.query(sql`SELECT name,version,state,sha256,size FROM plugin_releases ORDER BY name,version`);
  assert.deepEqual(stored.map(row => [row.name, row.version, row.state]), [['dhcp', '1.0.0', 'active'], ['dhcp', '1.1.0', 'active'], ['dhcp', '1.2.0', 'active'], ['dns', '1.0.0', 'active']], 'the three highest dhcp versions and the dns plugin; 0.9.0, the draft and the bad tags are ignored');
  const imports = await database.query(sql`SELECT tag,kind,source,status,version FROM agent_release_imports ORDER BY tag`);
  assert.ok(imports.every(row => row.kind === 'plugin' && row.source === 'github' && row.status === 'imported'), 'import rows of kind plugin');
  assert.deepEqual(imports.map(row => row.tag), ['plugin-dhcp-v1.0.0', 'plugin-dhcp-v1.1.0', 'plugin-dhcp-v1.2.0', 'plugin-dns-v1.0.0']);
  const file = await database.one(sql`SELECT path,size,sha256,chunks FROM plugin_release_files WHERE release_id=${dhcp[1].record.id}`);
  assert.deepEqual([file.path, Number(file.size), file.sha256], [`/downloads/${dhcp[1].names.exe}`, dhcp[1].files.exe.length, dhcp[1].record.sha256]);
  assert.ok(await storage.head(releaseChunkKey(JSON.parse(file.chunks)[0].sha256)), 'the chunk is in the object storage under its SHA-256');
  const audit = await database.query(sql`SELECT action,target,actor FROM audit WHERE action=${pluginImportAuditActions.github} ORDER BY target`);
  assert.deepEqual(audit.map(row => row.target), ['dhcp 1.0.0', 'dhcp 1.1.0', 'dhcp 1.2.0', 'dns 1.0.0']);
  assert.equal(await count('jobs'), 0, 'importing plans no install or update');
  // Repeat: unchanged assets are present without a download. Two days later the chunk cleanup keeps the chunks of plugin releases.
  later(2 * 24 * 60 * 60_000);
  assert.deepEqual(await check(list, [...dhcp, dns, decoy]), { status: 'ok', imported: 0, present: 4, failed: 0, removedChunks: 0 });
  assert.ok(await storage.head(releaseChunkKey(JSON.parse(file.chunks)[0].sha256)), 'the cleanup keeps a chunk that a plugin release references');
  // GET /downloads/<file> serves the plugin EXE and refuses an unknown file.
  const route = routes(storage), get = name => route.GET(new Request(`${origin}/downloads/${name}`), { params: Promise.resolve({ file: name }) });
  const response = await get(dhcp[1].names.exe);
  assert.equal(response.status, 200);
  assert.ok(Buffer.from(await response.arrayBuffer()).equals(dhcp[1].files.exe), 'the exact signed bytes');
  assert.equal((await get('ServerDesk-Plugin-dhcp-9.9.9-win-x64.exe')).status, 404);
  await database.exec(sql`UPDATE plugin_releases SET state='disabled' WHERE id=${dhcp[1].record.id}`);
  assert.equal((await get(dhcp[1].names.exe)).status, 200, 'a disabled release still serves its files');
}));

test('a release with parts stores one chunk per part and serves every part path', () => fixture(async ({ database, storage, check }) => {
  const big = Buffer.alloc(pluginReleasePartSize + 7, 3), release = buildPlugin('dhcp', '1.0.0', { exe: big });
  assert.equal((await check([listed(release)], [release])).imported, 1);
  const paths = (await database.query(sql`SELECT path FROM plugin_release_files WHERE release_id=${release.record.id} ORDER BY path`)).map(row => row.path);
  assert.deepEqual(paths, [`/downloads/${release.names.exe}`, `/downloads/${release.names.exe}.part1`, `/downloads/${release.names.exe}.part2`]);
  const route = routes(storage);
  const part = await route.GET(new Request(`${origin}/downloads/${release.names.exe}.part2`), { params: Promise.resolve({ file: `${release.names.exe}.part2` }) });
  assert.equal(Buffer.from(await part.arrayBuffer()).length, 7);
}));

test('missing files, a foreign signature, a version conflict and a path conflict fail with their reasons', () => fixture(async ({ database, check, count }) => {
  assert.ok(releaseImportFailures.includes('pluginAssetsMissing'));
  assert.equal(releaseImportReasonText.pluginAssetsMissing, 'The plugin release is missing files. It needs the EXE, the record, the manifest and the signature.');
  const missing = buildPlugin('dhcp', '1.0.0'), unsigned = buildPlugin('dhcp', '1.1.0', { key: foreign.privateKey });
  assert.deepEqual(await check([listed(missing, { omit: ['signature'] }), listed(unsigned)], [missing, unsigned]), { status: 'ok', imported: 0, present: 0, failed: 2, removedChunks: 0 });
  const reasons = Object.fromEntries((await database.query(sql`SELECT tag,reason,kind FROM agent_release_imports`)).map(row => [row.tag, [row.reason, row.kind]]));
  assert.deepEqual(reasons, { 'plugin-dhcp-v1.0.0': ['pluginAssetsMissing', 'plugin'], 'plugin-dhcp-v1.1.0': ['signatureInvalid', 'plugin'] });
  // The same name and version with other bytes conflicts.
  const first = buildPlugin('dns', '1.0.0'), second = buildPlugin('dns', '1.0.0', { exe: Buffer.from('other dns bytes') });
  assert.equal((await check([listed(first)], [first])).imported, 1);
  assert.equal((await check([listed(second)], [second])).failed, 1);
  assert.equal((await database.one(sql`SELECT reason FROM agent_release_imports WHERE tag='plugin-dns-v1.0.0'`)).reason, 'versionConflict');
  // A path that an agent release file already serves with other bytes conflicts.
  const clash = buildPlugin('dhcp', '1.3.0'), agentId = randomUUID();
  await database.exec(sql`INSERT INTO agent_releases (id,version,manifest,signature,sha256,size,created_at) VALUES (${agentId},'9.9.9','{}','x',${'a'.repeat(64)},1,1)`);
  await database.exec(sql`INSERT INTO agent_release_files (release_id,path,size,sha256,chunks) VALUES (${agentId},${clash.manifest.exe.path},5,${'b'.repeat(64)},'[]')`);
  assert.equal((await check([listed(clash)], [clash])).failed, 1);
  assert.equal((await database.one(sql`SELECT reason FROM agent_release_imports WHERE tag='plugin-dhcp-v1.3.0'`)).reason, 'pathConflict', 'across agent and plugin files');
  assert.equal(await count('plugin_releases'), 1, 'only the first dns release is stored');
}));

test('a check that lost its lease writes no present or failed plugin import row and is skipped', () => fixture(async ({ database, check, count }) => {
  const release = buildPlugin('dhcp', '1.0.0'), unsigned = buildPlugin('dns', '1.0.0', { key: foreign.privateKey });
  assert.equal((await check([listed(release)], [release])).imported, 1);
  const row = () => database.one(sql`SELECT tag,source,status,reason,fingerprint,attempted_at,kind FROM agent_release_imports WHERE tag=${release.tag}`);
  // Another fingerprint (another update time), so the stored release is checked again and is present.
  const relisted = { ...listed(release), assets: listed(release).assets.map(asset => ({ ...asset, updated_at: '2026-11-02T00:00:00Z' })) };
  const before = await row();
  // A fetch that hands the lease to another holder just before the signature is downloaded.
  const stealing = (list, releases, target) => {
    const base = github(list, releases);
    return async (url, init) => {
      if (url.endsWith(`/releases/assets/${target.ids.signature}`)) await database.exec(sql`UPDATE agent_release_source SET lease_holder='another-check'`);
      return base(url, init);
    };
  };
  assert.deepEqual(await check([relisted], [release], { fetch: stealing([relisted], [release], release) }), { status: 'skipped' }, 'present: the lost lease skips the check');
  assert.deepEqual(await row(), before, 'the present plugin import row is not written');
  await database.exec(sql`UPDATE agent_release_source SET lease_holder=NULL,lease_until=NULL`);
  assert.deepEqual(await check([listed(unsigned)], [unsigned], { fetch: stealing([listed(unsigned)], [unsigned], unsigned) }), { status: 'skipped' }, 'failed: the lost lease skips the check');
  assert.equal(await count('agent_release_imports'), 1, 'the failed plugin import row is not written');
  // Under its own lease both rows are written.
  await database.exec(sql`UPDATE agent_release_source SET lease_holder=NULL,lease_until=NULL`);
  assert.deepEqual(await check([relisted, listed(unsigned)], [release, unsigned]), { status: 'ok', imported: 0, present: 1, failed: 1, removedChunks: 0 });
  assert.deepEqual([(await row()).status, (await database.one(sql`SELECT reason FROM agent_release_imports WHERE tag=${unsigned.tag}`)).reason], ['present', 'signatureInvalid']);
}));

test('a path that another plugin release serves blocks an agent import, and the kind column defaults to agent', () => fixture(async ({ database }) => {
  const id = randomUUID();
  await database.exec(sql`INSERT INTO plugin_releases (id,name,version,manifest,signature,sha256,size,created_at) VALUES (${id},'dhcp','1.0.0','{}','x',${'a'.repeat(64)},1,1)`);
  await database.exec(sql`INSERT INTO plugin_release_files (release_id,path,size,sha256,chunks) VALUES (${id},'/downloads/ServerDesk-Plugin-dhcp-1.0.0-win-x64.exe',1,${'a'.repeat(64)},'[]')`);
  await database.exec(sql`INSERT INTO agent_release_imports (tag,source,version,status,attempted_at) VALUES ('agent-v1.0.0','github','1.0.0','imported',1)`);
  assert.equal((await database.one(sql`SELECT kind FROM agent_release_imports WHERE tag='agent-v1.0.0'`)).kind, 'agent', 'an existing or agent import row has kind agent');
  await assert.rejects(database.exec(sql`INSERT INTO agent_release_imports (tag,source,version,status,attempted_at,kind) VALUES ('x','github','1','imported',1,'other')`), /agent_release_imports_kind_check/);
  await assert.rejects(database.exec(sql`INSERT INTO plugin_releases (id,name,version,manifest,signature,sha256,size,created_at) VALUES (${randomUUID()},'dhcp','1.0.0','{}','x',${'a'.repeat(64)},1,1)`), /plugin_releases_name_version_key/, 'one row per name and version');
}));

test('import-release <dir> imports a plugin folder offline through the same checks', () => fixture(async ({ database, storage, directory }) => {
  const folder = path.join(directory, 'plugin'), release = buildPlugin('dhcp', '1.0.0');
  await mkdir(folder);
  for (const kind of kinds) await writeFile(path.join(folder, release.names[kind]), release.files[kind]);
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('offline'); };
  try {
    assert.deepEqual(await importRelease(database, { directory: folder, storage, publicKeyPem }), { kind: 'plugin', name: 'dhcp', version: '1.0.0', releaseId: release.record.id, status: 'imported' });
    assert.deepEqual(await importRelease(database, { directory: folder, storage, publicKeyPem }), { kind: 'plugin', name: 'dhcp', version: '1.0.0', releaseId: release.record.id, status: 'present' });
  } finally { globalThis.fetch = original; }
  const row = await database.one(sql`SELECT source,kind,status FROM agent_release_imports WHERE tag='plugin-dhcp-v1.0.0'`);
  assert.deepEqual([row.source, row.kind, row.status], ['folder', 'plugin', 'present']);
  assert.equal((await database.one(sql`SELECT count(*) AS n FROM audit WHERE action=${pluginImportAuditActions.folder}`)).n, 1, 'the audit row "Plugin release imported from a folder"');
  const broken = path.join(directory, 'broken');
  await mkdir(broken);
  for (const kind of ['record', 'manifest', 'signature']) await writeFile(path.join(broken, release.names[kind]), release.files[kind]);
  await assert.rejects(importRelease(database, { directory: broken, storage, publicKeyPem }), { message: `The folder ${broken} has no file ${release.names.exe}.` });
  const foreignFolder = path.join(directory, 'foreign'), signed = buildPlugin('dhcp', '1.0.5', { key: foreign.privateKey });
  await mkdir(foreignFolder);
  for (const kind of kinds) await writeFile(path.join(foreignFolder, signed.names[kind]), signed.files[kind]);
  await assert.rejects(importRelease(database, { directory: foreignFolder, storage, publicKeyPem }), { message: 'Plugin dhcp 1.0.5 was not imported: The signature does not match the publisher key of this portal. The release was not imported.' });
}));
