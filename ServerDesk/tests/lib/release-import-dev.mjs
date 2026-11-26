// Dev pre-releases in the release import (runtime/release-import.mjs) on PostgreSQL: a fake fetch serves the
// GitHub list pages and the assets, a throwaway P-256 publisher stands for the pinned key and the files go to
// filesystem storage in a temp folder. Covered: with Import dev builds off a dev tag (pre-release or not) makes
// no candidate, no download and no import row; with it on the 3 newest dev pre-releases by published_at for the
// agent and per plugin name import through the same checks, and a dev tag without the pre-release flag or a
// pre-release without a dev tag never imports; the list reads up to 3 pages of 100 and follows only a next link
// on api.github.com, so a release behind 100 dev pre-releases still imports; the release of a base imports after
// a dev build of that base without a conflict.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sql } from '../../runtime/database.mjs';
import { agentReleaseFiles } from '../../runtime/agent-release-verify.mjs';
import { pluginReleaseFiles } from '../../runtime/plugin-release-verify.mjs';
import { releaseAssetUrl, releaseImportLimits, releaseListUrl, runReleaseCheck } from '../../runtime/release-import.mjs';
import { createStorage } from '../../runtime/storage.mjs';
import { sourceDatabase } from '../support/source-database.mjs';

const publisher = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const publicKeyPem = publisher.publicKey.export({ type: 'spki', format: 'pem' });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const timers = { setInterval: () => ({ unref() { return this; } }), clearInterval() {} };
const agentKinds = ['zip', 'exe', 'record', 'manifest', 'signature'], pluginKinds = ['exe', 'record', 'manifest', 'signature'];
let nextAssetId = 9000;

/** A signed agent release (X.Y.Z or a dev build) with its five assets. */
function agentRelease(version) {
  const names = agentReleaseFiles(version), zip = Buffer.from(`zip of the agent ${version}`), exe = Buffer.from(`exe of the agent ${version}`);
  const manifest = { version, protocolVersion: 3, minProtocolVersion: 3, os: ['Windows 11 Pro'], arch: 'x64', path: `/downloads/${names.zip}`, sha256: hash(zip), size: zip.length,
    layout: 'single-exe', exe: { path: `/downloads/${names.exe}`, sha256: hash(exe), size: exe.length }, changelog: { features: [`Agent ${version}`], fixes: [] }, createdAt: '2026-11-20T00:00:00.000Z' };
  const text = JSON.stringify(manifest), signature = sign('sha256', Buffer.from(text), publisher.privateKey).toString('base64');
  const record = { id: randomUUID(), version, manifest: text, signature, sha256: manifest.sha256, size: manifest.size, createdAt: Date.UTC(2026, 10, 20) };
  const files = { zip, exe, record: Buffer.from(JSON.stringify(record, null, 2) + '\n'), manifest: Buffer.from(text), signature: Buffer.from(signature) };
  return { kinds: agentKinds, version, tag: `agent-v${version}`, names, record, files, ids: Object.fromEntries(agentKinds.map(kind => [kind, ++nextAssetId])) };
}
/** A signed plugin release (X.Y.Z or a dev build) with its four assets. */
function pluginRelease(name, version) {
  const names = pluginReleaseFiles(name, version), exe = Buffer.from(`exe of the plugin ${name} ${version}`);
  const manifest = { kind: 'plugin', name, target: name, role: name, version, minAgentVersion: '4.16.0', protocolVersion: 1, os: ['Windows Server 2022'], arch: 'x64', capabilities: [`${name}-read`],
    exe: { path: `/downloads/${names.exe}`, sha256: hash(exe), size: exe.length }, changelog: { features: [`Plugin ${version}`], fixes: [] }, createdAt: '2026-11-20T00:00:00.000Z' };
  const text = JSON.stringify(manifest), signature = sign('sha256', Buffer.from(text), publisher.privateKey).toString('base64');
  const record = { id: randomUUID(), name, version, manifest: text, signature, sha256: manifest.exe.sha256, size: manifest.exe.size, createdAt: Date.UTC(2026, 10, 20) };
  const files = { exe, record: Buffer.from(JSON.stringify(record, null, 2) + '\n'), manifest: Buffer.from(text), signature: Buffer.from(signature) };
  return { kinds: pluginKinds, name, version, tag: `plugin-${name}-v${version}`, names, record, files, ids: Object.fromEntries(pluginKinds.map(kind => [kind, ++nextAssetId])) };
}
/** The GitHub list entry of a release; a dev build is a published pre-release unless said otherwise. */
const listed = (release, { prerelease = release.version.includes('-dev.'), publishedAt = '2026-11-20T00:00:00Z', tag = release.tag } = {}) => ({
  tag_name: tag, draft: false, prerelease, published_at: publishedAt,
  assets: release.kinds.map(kind => ({ id: release.ids[kind], name: release.names[kind], state: 'uploaded', size: release.files[kind].length, updated_at: publishedAt })),
});
const pageUrl = page => `https://api.github.com/repositories/1/releases?per_page=100&page=${page}`;
/**
 * A fake GitHub: `pages` are the list pages (the first answers releaseListUrl, each further one pageUrl(n) and is
 * linked as rel="next"), `next` replaces the next link of the first page; the assets of `releases` are served.
 */
function github({ pages, releases, next }) {
  const calls = [], assets = new Map();
  for (const release of releases) for (const kind of release.kinds) assets.set(releaseAssetUrl(release.ids[kind]), release.files[kind]);
  const fetch = async url => {
    calls.push(url);
    const index = url === releaseListUrl ? 0 : pages.findIndex((_page, number) => number > 0 && url === pageUrl(number + 1));
    if (index >= 0) {
      const link = index === 0 && next !== undefined ? next : index + 1 < pages.length ? `<${pageUrl(index + 2)}>; rel="next", <${pageUrl(pages.length)}>; rel="last"` : null;
      return Response.json(pages[index], { headers: link ? { link } : {} });
    }
    if (assets.has(url)) return new Response(assets.get(url));
    throw new TypeError(`unexpected request ${url}`);
  };
  return { fetch, calls, assetCalls: () => calls.filter(url => url.includes('/releases/assets/')) };
}

async function fixture(run) {
  const database = await sourceDatabase(), directory = await mkdtemp(path.join(os.tmpdir(), 'sd-release-dev-'));
  const storage = createStorage({ OBJECT_STORAGE_DRIVER: 'filesystem', OBJECT_STORAGE_PATH: path.join(directory, 'objects') });
  let time = Date.UTC(2026, 10, 21, 12);
  const check = gh => runReleaseCheck(database, { trigger: 'maintenance', storage, fetch: gh.fetch, clock: () => time++, timers, log: () => {}, publicKeyPem });
  const devBuilds = enabled => database.exec(sql`UPDATE agent_release_source SET dev_builds=${enabled} WHERE id=1`);
  const imports = async () => (await database.query(sql`SELECT tag,status,reason FROM agent_release_imports ORDER BY tag`)).map(row => [row.tag, row.status, row.reason]);
  const agents = async () => (await database.query(sql`SELECT version FROM agent_releases ORDER BY version`)).map(row => row.version);
  const plugins = async () => (await database.query(sql`SELECT name,version FROM plugin_releases ORDER BY name,version`)).map(row => `${row.name} ${row.version}`);
  try { await run({ database, check, devBuilds, imports, agents, plugins }); } finally { await database.close(); await rm(directory, { recursive: true, force: true }); }
}

test('with dev builds off a dev tag makes no candidate, no download and no import row; releases import as before', () => fixture(async ({ check, imports, agents, plugins }) => {
  const real = agentRelease('4.21.4'), dev = agentRelease('4.21.5-dev.abc1234'), unflagged = agentRelease('4.21.5-dev.bbbbbbb'), pluginDev = pluginRelease('dns', '1.0.4-dev.abc1234'), plugin = pluginRelease('dns', '1.0.3');
  const gh = github({ pages: [[listed(dev), listed(unflagged, { prerelease: false }), listed(pluginDev), listed(real), listed(plugin)]], releases: [real, dev, unflagged, pluginDev, plugin] });
  assert.deepEqual(await check(gh), { status: 'ok', imported: 2, present: 0, failed: 0, removedChunks: 0 });
  assert.deepEqual(await imports(), [['agent-v4.21.4', 'imported', null], ['plugin-dns-v1.0.3', 'imported', null]], 'no row for any dev tag');
  assert.deepEqual([await agents(), await plugins()], [['4.21.4'], ['dns 1.0.3']]);
  const devIds = new Set([dev, unflagged, pluginDev].flatMap(release => Object.values(release.ids)).map(id => releaseAssetUrl(id)));
  assert.equal(gh.assetCalls().filter(url => devIds.has(url)).length, 0, 'no download request for a dev build');
}));

test('with dev builds on the 3 newest dev pre-releases by published_at import for the agent and per plugin; unflagged dev tags and pre-releases without a dev tag never import', () => fixture(async ({ check, devBuilds, imports, agents, plugins }) => {
  await devBuilds(true);
  // Published order differs from the version text: the newest by published_at win.
  const devs = [['4.21.5-dev.aaaaaaa', '2026-11-20T01:00:00Z'], ['4.21.5-dev.bbbbbbb', '2026-11-20T04:00:00Z'], ['4.21.6-dev.ccccccc', '2026-11-20T02:00:00Z'], ['4.21.5-dev.ddddddd', '2026-11-20T03:00:00Z']].map(([version, at]) => ({ release: agentRelease(version), at }));
  const real = agentRelease('4.21.4'), unflagged = agentRelease('4.21.7-dev.eeeeeee'), preview = agentRelease('4.22.0');
  const dns = [['1.0.4-dev.1111111', '2026-11-20T01:00:00Z'], ['1.0.4-dev.2222222', '2026-11-20T02:00:00Z'], ['1.0.4-dev.3333333', '2026-11-20T03:00:00Z'], ['1.0.4-dev.4444444', '2026-11-20T04:00:00Z']].map(([version, at]) => ({ release: pluginRelease('dns', version), at }));
  const dhcp = pluginRelease('dhcp', '1.1.2-dev.5555555');
  const list = [...devs.map(({ release, at }) => listed(release, { publishedAt: at })), listed(real), listed(unflagged, { prerelease: false }), listed(preview, { prerelease: true }),
    ...dns.map(({ release, at }) => listed(release, { publishedAt: at })), listed(dhcp)];
  const gh = github({ pages: [list], releases: [...devs.map(item => item.release), real, unflagged, preview, ...dns.map(item => item.release), dhcp] });
  const result = await check(gh);
  assert.deepEqual([result.status, result.imported, result.failed], ['ok', 1 + 3 + 3 + 1, 0]);
  assert.deepEqual(await agents(), ['4.21.4', '4.21.5-dev.bbbbbbb', '4.21.5-dev.ddddddd', '4.21.6-dev.ccccccc'], 'the release and the 3 newest dev builds by published_at');
  assert.deepEqual(await plugins(), ['dhcp 1.1.2-dev.5555555', 'dns 1.0.4-dev.2222222', 'dns 1.0.4-dev.3333333', 'dns 1.0.4-dev.4444444'], '3 per plugin name');
  const tags = (await imports()).map(([tag]) => tag);
  for (const tag of ['agent-v4.21.7-dev.eeeeeee', 'agent-v4.22.0', 'agent-v4.21.5-dev.aaaaaaa', 'plugin-dns-v1.0.4-dev.1111111']) assert.ok(!tags.includes(tag), `${tag} makes no row`);
  // The dev builds went through the same checks: a bad signature fails the dev build as it fails a release.
  const broken = agentRelease('4.21.8-dev.fffffff');
  broken.files.signature = Buffer.from(sign('sha256', Buffer.from('other bytes'), publisher.privateKey).toString('base64'));
  const again = github({ pages: [[listed(broken, { publishedAt: '2026-11-21T00:00:00Z' })]], releases: [broken] });
  assert.equal((await check(again)).failed, 1);
  assert.deepEqual((await imports()).find(([tag]) => tag === broken.tag), [broken.tag, 'failed', 'manifestInvalid']);
}));

test('the list reads up to 3 pages of 100, follows only a next link on api.github.com and finds a release behind 100 dev pre-releases', () => fixture(async ({ database, check, imports, agents }) => {
  assert.equal(releaseListUrl, 'https://api.github.com/repos/nodiverna/nodiverna/releases?per_page=100');
  assert.equal(releaseImportLimits.listPages, 3);
  const devs = Array.from({ length: 100 }, (_, index) => agentRelease(`4.21.5-dev.${index.toString(16).padStart(7, '0')}`));
  const real = agentRelease('4.21.4'), fourth = agentRelease('4.21.3');
  const gh = github({ pages: [devs.map(release => listed(release)), [listed(real)], [], [listed(fourth)]], releases: [...devs, real, fourth] });
  assert.deepEqual(await check(gh), { status: 'ok', imported: 1, present: 0, failed: 0, removedChunks: 0 });
  assert.deepEqual(await agents(), ['4.21.4'], 'the release on page 2 imports; page 4 is never read');
  assert.deepEqual(gh.calls.filter(url => !url.includes('/releases/assets/')), [releaseListUrl, pageUrl(2), pageUrl(3)], 'three list requests at most');
  assert.deepEqual((await imports()).map(([tag]) => tag), ['agent-v4.21.4']);
  // A next link to another host fails the list with invalidResponse and requests nothing there.
  for (const next of ['<https://evil.example/releases?page=2>; rel="next"', '<http://api.github.com/releases?page=2>; rel="next"', '<https://user@api.github.com/releases?page=2>; rel="next"', '<https://api.github.com:8443/releases?page=2>; rel="next"']) {
    const foreign = github({ pages: [[listed(real)], [listed(fourth)]], releases: [real, fourth], next });
    assert.equal((await check(foreign)).status, 'failed', next);
    assert.equal((await database.one(sql`SELECT last_error FROM agent_release_source WHERE id=1`)).last_error, 'serverMessage.releaseImport.invalidResponse', next);
    assert.deepEqual(foreign.calls, [releaseListUrl], `${next}: nothing else is requested`);
  }
  // A failed page fails the list as today.
  const failing = github({ pages: [[listed(real)], [listed(fourth)]], releases: [real, fourth] });
  const fetch = failing.fetch;
  failing.fetch = async url => url === pageUrl(2) ? new Response('{}', { status: 500 }) : fetch(url);
  assert.equal((await check(failing)).status, 'failed');
  // Each page has its own size cap.
  const big = github({ pages: [[listed(real)], [listed(fourth)]], releases: [real, fourth] });
  const bigFetch = big.fetch;
  big.fetch = async url => url === pageUrl(2) ? new Response('[' + ' '.repeat(releaseImportLimits.listBytes) + ']') : bigFetch(url);
  assert.equal((await check(big)).status, 'failed');
  assert.equal((await database.one(sql`SELECT last_error FROM agent_release_source WHERE id=1`)).last_error, 'serverMessage.releaseImport.invalidResponse');
}));

test('the release of a base imports after a dev build of that base without a version or path conflict', () => fixture(async ({ check, devBuilds, imports, agents, plugins }) => {
  await devBuilds(true);
  const dev = agentRelease('4.21.5-dev.abc1234'), pluginDev = pluginRelease('dns', '1.0.4-dev.abc1234');
  assert.equal((await check(github({ pages: [[listed(dev), listed(pluginDev)]], releases: [dev, pluginDev] }))).imported, 2);
  const real = agentRelease('4.21.5'), plugin = pluginRelease('dns', '1.0.4');
  const result = await check(github({ pages: [[listed(real), listed(dev), listed(plugin), listed(pluginDev)]], releases: [real, dev, plugin, pluginDev] }));
  assert.deepEqual([result.imported, result.failed], [2, 0]);
  assert.deepEqual(await agents(), ['4.21.5', '4.21.5-dev.abc1234']);
  assert.deepEqual(await plugins(), ['dns 1.0.4', 'dns 1.0.4-dev.abc1234']);
  assert.ok((await imports()).every(([, status]) => status !== 'failed'), 'no versionConflict or pathConflict');
}));
