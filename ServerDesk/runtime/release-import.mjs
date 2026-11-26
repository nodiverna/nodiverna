import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import publisher from '../lib/release-publisher.json' with { type: 'json' };
import { AgentReleaseError, agentReleaseFiles, agentReleasePartSize, verifyAgentRelease } from './agent-release-verify.mjs';
import { PluginReleaseError, pluginReleaseFiles, verifyPluginRelease } from './plugin-release-verify.mjs';
import { sql } from './database.mjs';
import { pluginImportAuditActions, releaseImportAuditActions } from './audit-actions.mjs';
import { isReleaseDownloadPath, releaseFileEntries } from './release-manifest.mjs';
import { manifestSchema, pluginManifestSchema } from './release-schema.mjs';
import { baseVersionSource, devSuffixSource } from './release-version.mjs';
import { portalVersion } from './usage-report.mjs';

/**
 * Agent releases from GitHub (docs/self-hosting.md, "Agent releases from
 * GitHub"). The portal reads the releases of the fixed repository
 * nodiverna/nodiverna, takes the three highest agent-vX.Y.Z releases, checks
 * each signed record against the pinned publisher key (lib/release-publisher.json)
 * and every SHA-256, stores the ZIP and the EXE as 20 MiB chunks in the object
 * storage and adds the release to the catalog. Agents download the files from
 * the portal (/downloads/, streamReleaseFile); they never contact GitHub.
 * Importing never plans an update: deploying stays a manual step.
 * Plugin releases (tags plugin-<name>-vX.Y.Z, docs/agent-plugins.md) come
 * through the same check: the three highest versions per plugin name, their
 * signed record against the same publisher key, the EXE as chunks in the same
 * storage, and the rows plugin_releases and plugin_release_files. Importing a
 * plugin never plans an install or an update either.
 * Dev pre-releases (tags agent-vX.Y.Z-dev.<sha7> and
 * plugin-<name>-vX.Y.Z-dev.<sha7>, published as GitHub pre-releases from the dev
 * branch) are imported only while an Owner turned on Import dev builds
 * (agent_release_source.dev_builds): then also the 3 newest by published_at for
 * the agent and for each plugin name, through the same checks. A dev tag
 * without the pre-release flag and a pre-release without a dev tag are never
 * imported. A folder import takes a dev release folder whatever the switch says.
 *
 * One module for the daily maintenance (runtime/maintenance.mjs), the
 * scheduler tick for Check now (runtime/maintenance-scheduler.mjs through
 * lib/server/agent/release-source.ts) and the offline import of a release folder
 * (scripts/selfhost.mjs import-release). A check runs only under the lease in
 * agent_release_source, so the maintenance, the scheduler and other replicas
 * never check at the same time. The import is the only writer of
 * agent_releases: the release row and its file rows commit in one transaction.
 * A fresh installation (no check started yet) checks once by itself at the
 * first scheduler tick. After the imports each check deletes the stored chunks
 * that no release which is not deleted references (cleanupReleaseChunks).
 *
 * The repository is public: every request goes out without sign-in, so
 * GitHub allows about 60 requests per hour for each IP address (up to three
 * for the list, one for each downloaded file). The list reads at most 3 pages
 * of 100 releases, so many dev pre-releases never hide a release. A rate-limited answer fails with the
 * reason rateLimited; after it the check sends no more requests, and the next
 * check tries again. Redirects are followed by hand, only to api.github.com
 * and hosts below githubusercontent.com.
 */

export const releaseRepository = 'nodiverna/nodiverna';
export const releaseListUrl = `https://api.github.com/repos/${releaseRepository}/releases?per_page=100`;
export const releaseAssetUrl = id => `https://api.github.com/repos/${releaseRepository}/releases/assets/${id}`;
export const releaseImportLimits = Object.freeze({
  leaseMs: 15 * 60_000, renewMs: 60_000,
  listTimeoutMs: 30_000, assetTimeoutMs: 10 * 60_000, listBytes: 4 * 1024 * 1024, listPages: 3, maxRedirects: 3, considered: 3,
  record: 16 * 1024, manifest: 8192, signature: 256, zip: 104857600, exe: 250000000,
});
/** The size limits of the four files of a plugin release. */
export const pluginImportLimits = Object.freeze({ record: 16 * 1024, manifest: 8192, signature: 256, exe: 104857600 });
/** Every failure reason; serverMessage.releaseImport.<reason> is its text. */
export const releaseImportFailures = Object.freeze(['unreachable', 'timeout', 'rateLimited', 'notFound', 'invalidResponse',
  'assetsMissing', 'pluginAssetsMissing', 'tooLarge', 'signatureInvalid', 'manifestInvalid', 'hashMismatch', 'versionConflict', 'pathConflict', 'storageFailed']);
/** The daily check skips a failed release with one of these reasons until its assets change. */
export const permanentReleaseFailures = new Set(['assetsMissing', 'pluginAssetsMissing', 'tooLarge', 'signatureInvalid', 'manifestInvalid', 'hashMismatch', 'versionConflict', 'pathConflict']);
export const releaseImportErrorKey = reason => `serverMessage.releaseImport.${reason}`;
export { pluginImportAuditActions, releaseImportAuditActions };
/** The object storage prefix of the chunks. */
export const releaseChunkPrefix = 'agent-releases/sha256/';
/** The object storage key of one chunk: its own SHA-256, so equal chunks are stored once. */
export const releaseChunkKey = sha256 => `${releaseChunkPrefix}${sha256}`;
/**
 * The cleanup deletes an unreferenced chunk only when it was written more than
 * this long ago, so a running import never loses a chunk it has just stored.
 * An import writes an existing chunk again when it is older than refreshMs,
 * so every chunk that an import relies on is young.
 */
export const releaseChunkLimits = Object.freeze({ unusedMs: 24 * 60 * 60_000, refreshMs: 60 * 60_000, listLimit: 1000 });

/** The English text of a reason, for the CLI (the portal shows the catalog text of the key). */
export const releaseImportReasonText = Object.freeze({
  unreachable: 'GitHub could not be reached. Check the outbound connection to api.github.com.',
  timeout: 'GitHub did not answer in time. The next check tries again.',
  rateLimited: 'GitHub limits the requests from this portal for now. The limit resets within an hour, and the next check tries again.',
  notFound: 'GitHub did not find the repository nodiverna/nodiverna. The next check tries again.',
  invalidResponse: 'GitHub sent an answer that the portal cannot read. The next check tries again.',
  assetsMissing: 'The release is missing files. It needs the ZIP, the EXE, the record, the manifest and the signature.',
  pluginAssetsMissing: 'The plugin release is missing files. It needs the EXE, the record, the manifest and the signature.',
  tooLarge: 'A file of the release is larger than allowed.',
  signatureInvalid: 'The signature does not match the publisher key of this portal. The release was not imported.',
  manifestInvalid: 'The signed manifest is not valid for this portal.',
  hashMismatch: 'A downloaded file does not match its SHA-256 in the signed manifest.',
  versionConflict: 'The catalog already has a different release with this version.',
  pathConflict: 'Another file is already served under one of the paths of this release.',
  storageFailed: 'The files could not be saved in the file storage. Check the storage and try again.',
});

const tagPattern = /^agent-v(\d+\.\d+\.\d+)$/;
const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const assetKinds = ['zip', 'exe', 'record', 'manifest', 'signature'];
const pluginTagPattern = /^plugin-([a-z][a-z0-9-]{1,31})-v(\d+\.\d+\.\d+)$/;
const pluginAssetKinds = ['exe', 'record', 'manifest', 'signature'];
const devVersionGroup = `(${baseVersionSource}${devSuffixSource})`;
const devTagPattern = new RegExp(`^agent-v${devVersionGroup}$`);
const devPluginTagPattern = new RegExp(`^plugin-([a-z][a-z0-9-]{1,31})-v${devVersionGroup}$`);
const apiHost = 'api.github.com';

/** A failure of one release or of the whole check, with its reason key. */
export class ReleaseImportFailure extends Error {
  constructor(reason) {
    super(releaseImportErrorKey(reason));
    this.name = 'ReleaseImportFailure';
    this.reason = reason;
  }
}
class LeaseLost extends Error {}
const fail = reason => new ReleaseImportFailure(reason);
const timeoutError = error => error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const num = value => value === null || value === undefined ? null : Number(value);
const semverParts = version => version.split('.').map(Number);
function compareVersions(left, right) {
  const a = semverParts(left), b = semverParts(right);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
}
async function discard(response) { try { await response.body?.cancel(); } catch { /* the status decides */ } }

/**
 * The next hop of a redirect: only https, the default port, no credentials and
 * only api.github.com or a host below githubusercontent.com. Anything else is
 * an invalid response.
 */
function redirectTarget(location, base) {
  let next;
  try { next = new URL(location ?? '', base); } catch { throw fail('invalidResponse'); }
  if (!location || next.protocol !== 'https:' || next.username || next.password || next.port
    || !(next.hostname === apiHost || next.hostname.endsWith('.githubusercontent.com'))) throw fail('invalidResponse');
  return next.href;
}

/**
 * One GET with manual redirects: at most 3 hops. No request carries an
 * Authorization header or a cookie: every request names the API version and
 * the portal version, nothing else.
 */
async function githubGet(fetcher, url, { accept, signal }) {
  let target = url;
  for (let hop = 0; ; hop++) {
    const headers = { Accept: accept, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': `ServerDesk/${portalVersion()}` };
    let response;
    try {
      response = await fetcher(target, { method: 'GET', headers, redirect: 'manual', credentials: 'omit', signal });
    } catch (error) { throw fail(timeoutError(error) ? 'timeout' : 'unreachable'); }
    if (!redirectStatuses.has(response.status)) return response;
    await discard(response);
    if (hop >= releaseImportLimits.maxRedirects) throw fail('invalidResponse');
    target = redirectTarget(response.headers.get('location'), target);
  }
}

/**
 * The failure of an answer that is not 2xx. GitHub limits unauthenticated
 * requests with 429, or with 403 and x-ratelimit-remaining 0 or retry-after
 * (the secondary limit). A public repository needs no sign-in: 401 and any
 * other 403 are answers the portal does not expect.
 */
function statusFailure(response) {
  if (response.status === 429 || (response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')))) return fail('rateLimited');
  if (response.status === 404) return fail('notFound');
  return fail('invalidResponse');
}

/** Reads the body up to `cap` bytes; a larger body fails with `overflow`. */
async function cappedBody(response, cap, overflow) {
  const length = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(length) && length > cap) { await discard(response); throw fail(overflow); }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      let result;
      try { result = await reader.read(); } catch (error) { throw fail(timeoutError(error) ? 'timeout' : 'unreachable'); }
      if (result.done) break;
      size += result.value.byteLength;
      if (size > cap) throw fail(overflow);
      chunks.push(result.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  return Buffer.concat(chunks);
}

/**
 * The next page of the release list: the URL of the rel="next" entry of the
 * Link header, or null without one. Only https on api.github.com without
 * credentials and port; any other next link is an invalid response.
 */
function nextPage(link) {
  if (!link) return null;
  const entry = link.split(',').map(part => /^\s*<([^>]*)>\s*;(.*)$/.exec(part)).find(match => match && /(?:^|;)\s*rel="?next"?\s*(?:;|$)/.test(match[2]));
  if (!entry) return null;
  let next;
  try { next = new URL(entry[1]); } catch { throw fail('invalidResponse'); }
  if (next.protocol !== 'https:' || next.hostname !== apiHost || next.username || next.password || next.port) throw fail('invalidResponse');
  return next.href;
}

/**
 * The release list: up to listPages pages of 100 releases, following only the
 * rel="next" link; each page has its own size cap. A page that cannot be read
 * fails the whole list.
 */
async function listReleases(fetcher) {
  const signal = AbortSignal.timeout(releaseImportLimits.listTimeoutMs), list = [];
  let url = releaseListUrl;
  for (let page = 0; url && page < releaseImportLimits.listPages; page++) {
    const response = await githubGet(fetcher, url, { accept: 'application/vnd.github+json', signal });
    if (response.status < 200 || response.status > 299) { await discard(response); throw statusFailure(response); }
    const next = nextPage(response.headers.get('link'));
    const body = await cappedBody(response, releaseImportLimits.listBytes, 'invalidResponse');
    let items;
    try { items = JSON.parse(body.toString('utf8')); } catch { throw fail('invalidResponse'); }
    if (!Array.isArray(items)) throw fail('invalidResponse');
    list.push(...items);
    url = next;
  }
  return list;
}

/** The time of publication of a GitHub release in milliseconds; 0 when it has none. */
const publishedAt = item => { const time = Date.parse(typeof item.published_at === 'string' ? item.published_at : ''); return Number.isFinite(time) ? time : 0; };
const assetsOf = item => Array.isArray(item.assets) ? item.assets : [];

/**
 * The candidates of one check: published releases (not draft, not prerelease)
 * with a tag agent-vX.Y.Z, the 3 highest versions, then the releases with a tag
 * plugin-<name>-vX.Y.Z, the 3 highest versions of each plugin name. With
 * `devBuilds` also the published pre-releases with a dev tag: the 3 newest by
 * published_at for the agent and for each plugin name. A list that cannot be
 * read fails the whole check.
 */
async function listCandidates(fetcher, { devBuilds = false } = {}) {
  const list = await listReleases(fetcher);
  const visible = list.filter(item => item && typeof item === 'object' && item.draft === false && typeof item.tag_name === 'string');
  const published = visible.filter(item => item.prerelease === false);
  const agents = published
    .filter(item => tagPattern.test(item.tag_name))
    .map(item => ({ kind: 'agent', tag: item.tag_name, version: tagPattern.exec(item.tag_name)[1], assets: Array.isArray(item.assets) ? item.assets : [] }))
    .sort((a, b) => compareVersions(b.version, a.version))
    .filter((item, index, all) => all.findIndex(other => other.version === item.version) === index)
    .slice(0, releaseImportLimits.considered);
  const plugins = published
    .filter(item => pluginTagPattern.test(item.tag_name))
    .map(item => { const [, name, version] = pluginTagPattern.exec(item.tag_name); return { kind: 'plugin', tag: item.tag_name, name, version, assets: Array.isArray(item.assets) ? item.assets : [] }; })
    .sort((a, b) => a.name.localeCompare(b.name) || compareVersions(b.version, a.version))
    .filter((item, index, all) => all.findIndex(other => other.name === item.name && other.version === item.version) === index)
    .filter((item, _index, all) => all.filter(other => other.name === item.name && compareVersions(other.version, item.version) > 0).length < releaseImportLimits.considered);
  if (!devBuilds) return [...agents, ...plugins];
  // Dev pre-releases: only with the pre-release flag and a dev tag, the newest first by publication.
  const prereleases = visible.filter(item => item.prerelease === true).sort((a, b) => publishedAt(b) - publishedAt(a));
  const devAgents = prereleases
    .filter(item => devTagPattern.test(item.tag_name))
    .map(item => ({ kind: 'agent', tag: item.tag_name, version: devTagPattern.exec(item.tag_name)[1], assets: assetsOf(item) }))
    .filter((item, index, all) => all.findIndex(other => other.version === item.version) === index)
    .slice(0, releaseImportLimits.considered);
  const devPlugins = prereleases
    .filter(item => devPluginTagPattern.test(item.tag_name))
    .map(item => { const [, name, version] = devPluginTagPattern.exec(item.tag_name); return { kind: 'plugin', tag: item.tag_name, name, version, assets: assetsOf(item) }; })
    .filter((item, index, all) => all.findIndex(other => other.name === item.name && other.version === item.version) === index)
    .filter((item, index, all) => all.slice(0, index).filter(other => other.name === item.name).length < releaseImportLimits.considered);
  return [...agents, ...devAgents, ...plugins, ...devPlugins];
}

/**
 * Cuts a stream into consecutive 20 MiB chunks and stores each one under its
 * SHA-256. Only one chunk is held in memory. With `parts`, chunk i must equal
 * parts[i] before it is stored; the whole file must match size and SHA-256.
 * @returns {Promise<{sha256: string, size: number}[]>}
 */
async function storeChunks(stream, expected, storage, clock) {
  const whole = createHash('sha256'), chunks = [];
  const buffer = Buffer.allocUnsafe(Math.min(agentReleasePartSize, expected.size));
  let filled = 0, total = 0;
  const flush = async () => {
    const bytes = buffer.subarray(0, filled), digest = sha256(bytes), part = expected.parts?.[chunks.length];
    if (expected.parts && (!part || part.size !== filled || part.sha256 !== digest)) throw fail('hashMismatch');
    await putChunk(storage, digest, bytes, clock);
    chunks.push({ sha256: digest, size: filled });
    filled = 0;
  };
  const reader = stream.getReader();
  try {
    for (;;) {
      let result;
      try { result = await reader.read(); } catch (error) { throw fail(timeoutError(error) ? 'timeout' : 'unreachable'); }
      if (result.done) break;
      const value = result.value;
      total += value.byteLength;
      if (total > expected.size) throw fail('hashMismatch');
      whole.update(value);
      for (let offset = 0; offset < value.byteLength;) {
        const take = Math.min(buffer.length - filled, value.byteLength - offset);
        buffer.set(value.subarray(offset, offset + take), filled);
        filled += take;
        offset += take;
        if (filled === buffer.length) await flush();
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  if (filled) await flush();
  if (total !== expected.size || whole.digest('hex') !== expected.sha256 || (expected.parts && chunks.length !== expected.parts.length)) throw fail('hashMismatch');
  return chunks;
}

/**
 * Stores one chunk unless an object of the same key and size exists that was
 * written less than refreshMs ago and whose stored bytes hash to the digest.
 * The bytes are read again because the ETags of S3 and Azure are not SHA-256:
 * a corrupt object under the right key is written again, not trusted. An older
 * object is written again too, so the cleanup never takes it while this import
 * runs. A failed read only means the chunk is written again.
 */
async function putChunk(storage, digest, bytes, clock) {
  const key = releaseChunkKey(digest);
  let reuse = false;
  try {
    const existing = await storage.head(key);
    const written = existing?.uploaded ? new Date(existing.uploaded).getTime() : NaN;
    reuse = !!existing && Number(existing.size) === bytes.length && clock() - written < releaseChunkLimits.refreshMs
      && await storedChunkMatches(storage, key, digest, bytes.length);
  } catch { reuse = false; }
  if (reuse) return;
  let stored;
  try { stored = await storage.put(key, bytes); } catch { throw fail('storageFailed'); }
  if (Number(stored?.size) !== bytes.length) throw fail('storageFailed');
}

/**
 * Whether the stored object of `key` has exactly `size` bytes with the SHA-256
 * `digest`. Streams the object, so at most one chunk is in memory; a missing
 * object, a read error or a longer object is false.
 */
async function storedChunkMatches(storage, key, digest, size) {
  let reader = null;
  try {
    const object = await storage.get(key);
    if (!object?.body) return false;
    reader = object.body.getReader();
    const hash = createHash('sha256');
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { reader = null; break; }
      received += value.byteLength;
      if (received > size) return false;
      hash.update(value);
    }
    return received === size && hash.digest('hex') === digest;
  } catch {
    return false;
  } finally {
    if (reader) await reader.cancel().catch(() => {});
  }
}

/**
 * The file rows of a manifest: the whole ZIP and EXE with all their chunks,
 * and each part with its one chunk.
 */
function fileRows(manifest, zipChunks, exeChunks) {
  const rows = [];
  for (const [entry, chunks] of [[manifest, zipChunks], [manifest.exe, exeChunks]]) {
    rows.push({ path: entry.path, size: entry.size, sha256: entry.sha256, chunks });
    (entry.parts ?? []).forEach((part, index) => rows.push({ path: part.path, size: part.size, sha256: part.sha256, chunks: [chunks[index]] }));
  }
  return rows;
}

/** LeaseLost unless `holder` still holds the lease; locks the source row for the rest of the transaction. */
async function assertLease(tx, holder) {
  const lease = await tx.one(sql`SELECT lease_holder FROM agent_release_source WHERE id=1 FOR UPDATE`);
  if (lease?.lease_holder !== holder) throw new LeaseLost('The release check lost its lease.');
}

const writeImportRow = (handle, row) => handle.exec(sql`INSERT INTO agent_release_imports(tag,source,version,status,reason,release_id,fingerprint,attempted_at,kind)
  VALUES(${row.tag},${row.source},${row.version},${row.status},${row.reason ?? null},${row.releaseId ?? null},${row.fingerprint ?? null},${row.attemptedAt},${row.kind ?? 'agent'})
  ON CONFLICT (tag) DO UPDATE SET source=excluded.source,version=excluded.version,status=excluded.status,reason=excluded.reason,release_id=excluded.release_id,fingerprint=excluded.fingerprint,attempted_at=excluded.attempted_at,kind=excluded.kind`);

/**
 * The import row of a check outside the release transaction (present, failed).
 * Under a lease (`holder` set) it commits only while the lease still holds:
 * a check that lost its lease writes no row. A folder import (no holder)
 * writes it directly.
 */
async function writeHeldImportRow(database, holder, row) {
  if (!holder) return writeImportRow(database, row);
  await database.transaction(async tx => {
    await assertLease(tx, holder);
    await writeImportRow(tx, row);
  });
}

/**
 * pathConflict when a path of `entries` is already served with other bytes:
 * a file of another agent release that is not deleted, or a file of another
 * plugin release.
 */
async function assertPathsFree(database, entries, { agentRelease = null, pluginRelease = null } = {}) {
  const paths = JSON.stringify(entries.map(entry => entry.path));
  const served = await database.query(sql`SELECT f.path,f.size,f.sha256 FROM agent_release_files f WHERE f.path IN (SELECT value FROM jsonb_array_elements_text(${paths}::jsonb))
    AND f.release_id IS DISTINCT FROM ${agentRelease} AND NOT EXISTS (SELECT 1 FROM agent_release_states s WHERE s.release_id=f.release_id AND s.state='deleted')
    UNION ALL SELECT p.path,p.size,p.sha256 FROM plugin_release_files p WHERE p.path IN (SELECT value FROM jsonb_array_elements_text(${paths}::jsonb)) AND p.release_id IS DISTINCT FROM ${pluginRelease}`);
  if (served.some(row => entries.some(entry => entry.path === row.path && (Number(row.size) !== entry.size || row.sha256 !== entry.sha256)))) throw fail('pathConflict');
}

/**
 * The checks of the record, the identity and the paths, all before any download. Returns the parsed
 * manifest and whether the release is already in the catalog.
 */
async function checkRecord(database, { version, recordBytes, manifestBytes, signatureBytes, publicKeyPem }) {
  let record;
  try { record = JSON.parse(recordBytes.toString('utf8')); } catch { throw fail('manifestInvalid'); }
  // The record must carry exactly the bytes of the two sibling files.
  if (!record || typeof record !== 'object' || typeof record.manifest !== 'string' || typeof record.signature !== 'string'
    || !Buffer.from(record.manifest, 'utf8').equals(manifestBytes) || !Buffer.from(record.signature, 'utf8').equals(signatureBytes)) throw fail('manifestInvalid');
  let manifest;
  try { manifest = verifyAgentRelease({ record, publicKeyPem, version }); } catch (error) { throw fail(error instanceof AgentReleaseError ? error.reason : 'manifestInvalid'); }
  // The schema of the catalog (lib/server/agent/releases.ts verifiedRelease): a row it refuses is never stored.
  if (!manifestSchema.safeParse(manifest).success || releaseFileEntries(manifest).some(entry => !isReleaseDownloadPath(entry.path))) throw fail('manifestInvalid');
  // Identity: the record id with the same signed bytes is present; any other clash is a conflict.
  const known = await database.query(sql`SELECT id,version,manifest FROM agent_releases WHERE id=${record.id} OR version=${record.version}`);
  const sameId = known.filter(item => item.id === record.id);
  if (sameId.some(item => item.manifest === record.manifest)) return { record, manifest, present: true };
  if (sameId.length || known.some(item => item.version === record.version)) throw fail('versionConflict');
  // Paths: a file of another stored release that is not deleted, with other content, is a conflict.
  await assertPathsFree(database, releaseFileEntries(manifest), { agentRelease: record.id });
  return { record, manifest, present: false };
}

/** The file entries of a plugin manifest: the EXE and its parts. */
const pluginFileEntries = manifest => [manifest.exe, ...(manifest.exe.parts ?? [])];

/**
 * The checks of a plugin record, the identity and the paths, all before any
 * download. Returns the parsed manifest and whether the release is already
 * stored. versionConflict: the same name and version with other bytes.
 */
async function checkPluginRecord(database, { name, version, recordBytes, manifestBytes, signatureBytes, publicKeyPem }) {
  let record;
  try { record = JSON.parse(recordBytes.toString('utf8')); } catch { throw fail('manifestInvalid'); }
  if (!record || typeof record !== 'object' || typeof record.manifest !== 'string' || typeof record.signature !== 'string'
    || !Buffer.from(record.manifest, 'utf8').equals(manifestBytes) || !Buffer.from(record.signature, 'utf8').equals(signatureBytes)) throw fail('manifestInvalid');
  let manifest;
  try { manifest = verifyPluginRelease({ record, publicKeyPem, name, version }); } catch (error) { throw fail(error instanceof PluginReleaseError ? error.reason : 'manifestInvalid'); }
  // The schema of the portal (lib/server/extensions/plugin-releases.ts verifiedPluginRelease): a row it refuses is never stored.
  if (!pluginManifestSchema.safeParse(manifest).success) throw fail('manifestInvalid');
  const stored = await database.query(sql`SELECT id,manifest,signature FROM plugin_releases WHERE id=${record.id} OR (name=${name} AND version=${version})`);
  if (stored.some(item => item.id === record.id && item.manifest === record.manifest && item.signature === record.signature)) return { record, manifest, present: true };
  if (stored.length) throw fail('versionConflict');
  await assertPathsFree(database, pluginFileEntries(manifest), { pluginRelease: record.id });
  return { record, manifest, present: false };
}

/**
 * Imports one plugin release whose three small files are read: the checks, the
 * download of the EXE into chunks, then one transaction with the release row,
 * the file rows, the import row (kind plugin) and the audit row.
 * @returns {Promise<{status: 'imported'|'present', releaseId: string}>}
 */
async function importPluginOne(database, input) {
  const { source, tag, version, fingerprint, open, storage, clock, holder } = input;
  const { record, manifest, present } = await checkPluginRecord(database, input);
  if (present) {
    await writeHeldImportRow(database, holder, { tag, source, version, status: 'present', releaseId: record.id, fingerprint, attemptedAt: clock(), kind: 'plugin' });
    return { status: 'present', releaseId: record.id };
  }
  const chunks = await storeChunks(await open('exe'), manifest.exe, storage, clock), time = clock();
  const rows = [{ path: manifest.exe.path, size: manifest.exe.size, sha256: manifest.exe.sha256, chunks },
    ...(manifest.exe.parts ?? []).map((part, index) => ({ path: part.path, size: part.size, sha256: part.sha256, chunks: [chunks[index]] }))];
  await database.transaction(async tx => {
    if (holder) await assertLease(tx, holder);
    // Another import of the same id or name and version may have committed meanwhile.
    if (await tx.one(sql`SELECT id FROM plugin_releases WHERE id=${record.id} OR (name=${record.name} AND version=${record.version}) LIMIT 1`)) throw fail('versionConflict');
    await tx.exec(sql`INSERT INTO plugin_releases (id,name,version,manifest,signature,sha256,size,created_at) VALUES (${record.id},${record.name},${record.version},${record.manifest},${record.signature},${record.sha256},${record.size},${time})`);
    for (const row of rows) await tx.exec(sql`INSERT INTO plugin_release_files (release_id,path,size,sha256,chunks) VALUES (${record.id},${row.path},${row.size},${row.sha256},${JSON.stringify(row.chunks)})`);
    await writeImportRow(tx, { tag, source, version, status: 'imported', releaseId: record.id, fingerprint, attemptedAt: time, kind: 'plugin' });
    await tx.exec(sql`INSERT INTO audit (at,actor,action,target,server_id,scope,customer_id) VALUES(${time},'System',${pluginImportAuditActions[source]},${`${record.name} ${record.version}`},NULL,'portal',NULL)`);
  });
  return { status: 'imported', releaseId: record.id };
}

/**
 * Imports one release whose three small files are read: the checks, the
 * download of the ZIP and the EXE into chunks, then one transaction with the
 * release row, the file rows, the import row and the audit row.
 * @returns {Promise<{status: 'imported'|'present', releaseId: string}>}
 */
async function importOne(database, input) {
  const { source, tag, version, fingerprint, open, storage, clock, holder } = input;
  const { record, manifest, present } = await checkRecord(database, input);
  if (present) {
    await writeHeldImportRow(database, holder, { tag, source, version, status: 'present', releaseId: record.id, fingerprint, attemptedAt: clock() });
    return { status: 'present', releaseId: record.id };
  }
  const zipChunks = await storeChunks(await open('zip'), manifest, storage, clock);
  const exeChunks = await storeChunks(await open('exe'), manifest.exe, storage, clock);
  const rows = fileRows(manifest, zipChunks, exeChunks), time = clock();
  await database.transaction(async tx => {
    if (holder) await assertLease(tx, holder);
    // Another import of the same id or version may have committed meanwhile.
    if (await tx.one(sql`SELECT id FROM agent_releases WHERE id=${record.id} OR version=${record.version} LIMIT 1`)) throw fail('versionConflict');
    await tx.exec(sql`INSERT INTO agent_releases (id,version,manifest,signature,sha256,size,created_at) VALUES (${record.id},${record.version},${record.manifest},${record.signature},${record.sha256},${record.size},${time})`);
    for (const row of rows) await tx.exec(sql`INSERT INTO agent_release_files (release_id,path,size,sha256,chunks) VALUES (${record.id},${row.path},${row.size},${row.sha256},${JSON.stringify(row.chunks)})`);
    await writeImportRow(tx, { tag, source, version, status: 'imported', releaseId: record.id, fingerprint, attemptedAt: time });
    await tx.exec(sql`INSERT INTO audit (at,actor,action,target,server_id,scope,customer_id) VALUES(${time},'System',${releaseImportAuditActions[source]},${record.version},NULL,'portal',NULL)`);
  });
  return { status: 'imported', releaseId: record.id };
}

/** The asset of each file name of the release kind, and the fingerprint of all of them. */
function releaseAssets(candidate) {
  const plugin = candidate.kind === 'plugin', kinds = plugin ? pluginAssetKinds : assetKinds;
  const names = plugin ? pluginReleaseFiles(candidate.name, candidate.version) : agentReleaseFiles(candidate.version), byName = new Map();
  for (const asset of candidate.assets) if (asset && typeof asset === 'object' && typeof asset.name === 'string' && !byName.has(asset.name)) byName.set(asset.name, asset);
  const found = Object.fromEntries(kinds.map(kind => [kind, byName.get(names[kind]) ?? null]));
  const fingerprint = JSON.stringify(kinds.map(kind => found[kind] ? [found[kind].id ?? null, found[kind].size ?? null, found[kind].updated_at ?? null] : null));
  return { found, fingerprint, kinds, limits: plugin ? pluginImportLimits : releaseImportLimits };
}

/**
 * One GitHub release; failures become its failed import row. Once a download
 * of this check was rate limited (context.rateLimited), a release that needs a
 * download fails with rateLimited at once and sends no request.
 */
async function checkGithubRelease(database, context, candidate, requested) {
  const { fetcher, clock } = context, { tag, version } = candidate, plugin = candidate.kind === 'plugin';
  const { found, fingerprint, kinds, limits } = releaseAssets(candidate);
  const previous = await database.one(sql`SELECT source,status,reason,fingerprint FROM agent_release_imports WHERE tag=${tag}`);
  if (previous?.source === 'github' && previous.fingerprint === fingerprint) {
    // Unchanged assets: a success stays as it is; a permanent failure waits for new assets or Check now.
    if (previous.status !== 'failed') return 'present';
    if (!requested && permanentReleaseFailures.has(previous.reason)) return 'failed';
  }
  try {
    if (kinds.some(kind => { const asset = found[kind]; return !asset || asset.state !== 'uploaded' || !Number.isSafeInteger(asset.id) || asset.id < 1 || !Number.isSafeInteger(asset.size) || asset.size < 0; })) throw fail(plugin ? 'pluginAssetsMissing' : 'assetsMissing');
    if (kinds.some(kind => found[kind].size > limits[kind])) throw fail('tooLarge');
    if (context.rateLimited) throw fail('rateLimited');
    const download = async (kind, cap) => {
      if (context.rateLimited) throw fail('rateLimited');
      const response = await githubGet(fetcher, releaseAssetUrl(found[kind].id), { accept: 'application/octet-stream', signal: AbortSignal.timeout(releaseImportLimits.assetTimeoutMs) });
      if (response.status < 200 || response.status > 299) { await discard(response); throw statusFailure(response); }
      if (cap !== undefined) return cappedBody(response, cap, 'tooLarge');
      if (!response.body) throw fail('hashMismatch');
      return response.body;
    };
    const recordBytes = await download('record', limits.record);
    const manifestBytes = await download('manifest', limits.manifest);
    const signatureBytes = await download('signature', limits.signature);
    const input = { ...context, source: 'github', tag, version, fingerprint, recordBytes, manifestBytes, signatureBytes, open: kind => download(kind) };
    const outcome = plugin ? await importPluginOne(database, { ...input, name: candidate.name }) : await importOne(database, input);
    return outcome.status;
  } catch (error) {
    if (!(error instanceof ReleaseImportFailure)) throw error;
    if (error.reason === 'rateLimited') context.rateLimited = true;
    // LeaseLost from this write propagates: it is never recorded as a failure.
    await writeHeldImportRow(database, context.holder, { tag, source: 'github', version, status: 'failed', reason: error.reason, fingerprint, attemptedAt: clock(), kind: candidate.kind });
    return 'failed';
  }
}

/**
 * Deletes the chunks below releaseChunkPrefix that no file row of an agent
 * release that is not deleted and no file row of a plugin release references and that were written more than unusedMs ago.
 * A chunk that such a release shares with a deleted release stays. It pages
 * through storage.list with the cursor and collects the candidates first; just
 * before each delete it reads the chunk again and keeps it when an import has
 * written it since. Any error (storage or database) stops the cleanup and is
 * logged; it never fails the check and never deletes a referenced chunk.
 * `held` returns false once the check lost its lease: then nothing more is deleted.
 * @returns {Promise<number>} the number of deleted chunks
 */
export async function cleanupReleaseChunks(database, { storage, clock = Date.now, log = message => console.error(message), held = () => true }) {
  let removed = 0;
  try {
    const rows = await database.query(sql`SELECT f.chunks FROM agent_release_files f
      WHERE NOT EXISTS (SELECT 1 FROM agent_release_states s WHERE s.release_id=f.release_id AND s.state='deleted')
      UNION ALL SELECT p.chunks FROM plugin_release_files p`);
    const referenced = new Set();
    for (const row of rows) {
      const chunks = typeof row.chunks === 'string' ? JSON.parse(row.chunks) : row.chunks;
      if (!Array.isArray(chunks)) throw new Error('A file row of a release has no chunk list.');
      for (const chunk of chunks) referenced.add(releaseChunkKey(chunk.sha256));
    }
    const old = written => { const time = new Date(written ?? NaN).getTime(); return Number.isFinite(time) && clock() - time > releaseChunkLimits.unusedMs; };
    const unused = [];
    let cursor;
    do {
      const page = await storage.list({ prefix: releaseChunkPrefix, limit: releaseChunkLimits.listLimit, ...(cursor ? { cursor } : {}) });
      for (const object of page.objects ?? []) if (object.key.startsWith(releaseChunkPrefix) && !referenced.has(object.key) && old(object.uploaded)) unused.push(object.key);
      if (page.truncated && !page.cursor) throw new Error('The object storage listing has no cursor.');
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    for (const key of unused) {
      if (!held()) break;
      const current = await storage.head(key);
      if (!current || !old(current.uploaded)) continue;
      await storage.delete(key);
      removed++;
    }
  } catch (error) {
    log(`ServerDesk: The cleanup of unused agent release chunks stopped (${error instanceof Error ? error.message : String(error)}). The next check tries again.`);
  }
  return removed;
}

/**
 * One check of the release source. trigger 'maintenance' always checks;
 * trigger 'request' (the scheduler tick) checks when Check now (or a
 * migration) asked for it, and once on a fresh installation that never started a
 * check. A requested check retries every failed release.
 * Returns {status:'not-requested'} or {status:'skipped'} (lease held) without
 * a request, {status:'ok'|'failed', imported, present, failed, removedChunks}
 * after a check. A failed list fails the check; a failed release does not.
 * The chunk cleanup runs after the imports, also after a failed list.
 * @param {any} database
 * @param {{trigger?: 'maintenance'|'request', storage: any, fetch?: typeof globalThis.fetch,
 *   clock?: () => number, timers?: any, log?: (message: string) => void,
 *   publicKeyPem?: string}} options
 */
export async function runReleaseCheck(database, {
  trigger = 'maintenance', storage, fetch: fetcher = globalThis.fetch, clock = Date.now, timers = globalThis,
  log = message => console.error(message), publicKeyPem = publisher.publicKey,
} = {}) {
  const holder = randomUUID(), started = clock();
  const lease = await database.transaction(async tx => {
    const row = await tx.one(sql`SELECT lease_until,requested_at,last_started_at,dev_builds FROM agent_release_source WHERE id=1 FOR UPDATE`);
    if (!row) return { status: 'skipped' };
    const requestedAt = num(row.requested_at), startedAt = num(row.last_started_at);
    // A fresh installation has never started a check: it counts as requested.
    const requested = startedAt === null || (requestedAt !== null && requestedAt > startedAt);
    if (trigger === 'request' && !requested) return { status: 'not-requested' };
    if (num(row.lease_until) !== null && Number(row.lease_until) > started) return { status: 'skipped' };
    await tx.exec(sql`UPDATE agent_release_source SET lease_holder=${holder},lease_until=${started + releaseImportLimits.leaseMs},last_started_at=${started} WHERE id=1`);
    return { status: 'leased', requested, devBuilds: row.dev_builds === true };
  });
  if (lease.status !== 'leased') return { status: lease.status };

  let lost = false;
  const renew = async () => {
    try {
      const renewed = await database.exec(sql`UPDATE agent_release_source SET lease_until=${clock() + releaseImportLimits.leaseMs} WHERE id=1 AND lease_holder=${holder}`);
      if (!renewed.rowCount) lost = true;
    } catch { /* tried again in a minute; the lease lasts 15 minutes */ }
  };
  const renewal = timers.setInterval(() => { void renew(); }, releaseImportLimits.renewMs);
  renewal?.unref?.();
  const finish = fields => database.exec(sql`UPDATE agent_release_source SET lease_holder=NULL,lease_until=NULL,last_finished_at=GREATEST(${clock()}::bigint,last_started_at),${fields} WHERE id=1 AND lease_holder=${holder}`);
  const counts = { imported: 0, present: 0, failed: 0 };
  try {
    let candidates = [], listFailure = null;
    try { candidates = await listCandidates(fetcher, { devBuilds: lease.devBuilds }); } catch (error) {
      if (!(error instanceof ReleaseImportFailure)) throw error;
      listFailure = error;
    }
    // rateLimited: set by the first rate-limited download; later releases send no request.
    const context = { fetcher, clock, storage, publicKeyPem, holder, rateLimited: false };
    for (const candidate of candidates) {
      if (lost) throw new LeaseLost('The release check lost its lease.');
      counts[await checkGithubRelease(database, context, candidate, lease.requested)]++;
    }
    if (lost) throw new LeaseLost('The release check lost its lease.');
    const removedChunks = await cleanupReleaseChunks(database, { storage, clock, log, held: () => !lost });
    if (listFailure) {
      await finish(sql`last_status='failed',last_error=${releaseImportErrorKey(listFailure.reason)}`);
      return { status: 'failed', ...counts, removedChunks };
    }
    await finish(sql`last_status='ok',last_error=NULL`);
    return { status: 'ok', ...counts, removedChunks };
  } catch (error) {
    if (error instanceof LeaseLost) return { status: 'skipped' };
    await finish(sql`last_status=last_status`).catch(() => {});
    throw error;
  } finally {
    timers.clearInterval(renewal);
  }
}

/**
 * The step of the daily maintenance: one check, never throws, never changes
 * the status of the run. {status:'skipped', removedChunks:0} while another
 * check holds the lease.
 */
export async function maintenanceReleaseCheck(database, { notice = () => {}, ...options } = {}) {
  try {
    const result = await runReleaseCheck(database, { ...options, trigger: 'maintenance' });
    if (result.status === 'ok' || result.status === 'failed') return { status: result.status, imported: result.imported, present: result.present, failed: result.failed, removedChunks: result.removedChunks };
    return { status: 'skipped', removedChunks: 0 };
  } catch (error) {
    notice(`The agent release check failed (${error instanceof Error ? error.message : String(error)}). The next run tries again.`);
    return { status: 'failed', imported: 0, present: 0, failed: 0, removedChunks: 0 };
  }
}

/** An error of import-release with an English message for the operator. */
export class ReleaseFolderError extends Error {}
// X.Y.Z or a dev build X.Y.Z-dev.<sha7>: a folder import takes a dev release whatever the switch says.
const folderVersion = `(\\d+\\.\\d+\\.\\d+(?:${devSuffixSource})?)`;
const folderRecord = new RegExp(`^ServerDesk-Agent-${folderVersion}-release\\.json$`);
const pluginFolderRecord = new RegExp(`^ServerDesk-Plugin-([a-z][a-z0-9-]{1,31})-${folderVersion}-release\\.json$`);

/** A plugin release folder: the same checks, chunks and transaction as a GitHub import of a plugin. */
async function importPluginFolder(database, { directory, name, version, storage, clock, publicKeyPem }) {
  const files = pluginReleaseFiles(name, version), sizes = {};
  for (const kind of pluginAssetKinds) {
    const info = await stat(path.join(directory, files[kind])).catch(() => null);
    if (!info?.isFile()) throw new ReleaseFolderError(`The folder ${directory} has no file ${files[kind]}.`);
    sizes[kind] = info.size;
  }
  const tag = `plugin-${name}-v${version}`;
  try {
    if (pluginAssetKinds.some(kind => sizes[kind] > pluginImportLimits[kind])) throw fail('tooLarge');
    const read = kind => readFile(path.join(directory, files[kind]));
    const [recordBytes, manifestBytes, signatureBytes] = await Promise.all([read('record'), read('manifest'), read('signature')]);
    const open = async kind => Readable.toWeb(createReadStream(path.join(directory, files[kind])));
    const outcome = await importPluginOne(database, { source: 'folder', tag, name, version, fingerprint: null, recordBytes, manifestBytes, signatureBytes, open, storage, publicKeyPem, clock, holder: null });
    return { kind: 'plugin', name, version, releaseId: outcome.releaseId, status: outcome.status };
  } catch (error) {
    if (!(error instanceof ReleaseImportFailure)) throw error;
    await writeImportRow(database, { tag, source: 'folder', version, status: 'failed', reason: error.reason, attemptedAt: clock(), kind: 'plugin' });
    throw new ReleaseFolderError(`Plugin ${name} ${version} was not imported: ${releaseImportReasonText[error.reason]}`);
  }
}

/**
 * import-release <dir>: imports one release folder without network access.
 * The folder holds exactly one ServerDesk-Agent-X.Y.Z-release.json and its
 * four sibling files, or exactly one ServerDesk-Plugin-<name>-X.Y.Z-release.json
 * and its three sibling files. The same checks, chunks and transaction as a
 * GitHub import; the import row has the source folder. Missing or ambiguous
 * files and every failure throw a ReleaseFolderError with an English message.
 * @returns {Promise<{kind?: 'plugin', name?: string, version: string, releaseId: string, status: 'imported'|'present'}>}
 */
export async function importReleaseFolder(database, {
  directory, storage, clock = Date.now, publicKeyPem = publisher.publicKey,
}) {
  let names;
  try { names = await readdir(directory); } catch { throw new ReleaseFolderError(`The folder ${directory} cannot be read.`); }
  const records = names.filter(name => folderRecord.test(name) || pluginFolderRecord.test(name)).sort();
  if (!records.length) throw new ReleaseFolderError(`The folder ${directory} has no ServerDesk-Agent-X.Y.Z-release.json and no ServerDesk-Plugin-<name>-X.Y.Z-release.json.`);
  if (records.length > 1) throw new ReleaseFolderError(`The folder ${directory} has more than one release record: ${records.join(', ')}. Keep exactly one release in the folder.`);
  const plugin = pluginFolderRecord.exec(records[0]);
  if (plugin) return importPluginFolder(database, { directory, name: plugin[1], version: plugin[2], storage, clock, publicKeyPem });
  const version = folderRecord.exec(records[0])[1], files = agentReleaseFiles(version), sizes = {};
  for (const kind of assetKinds) {
    const info = await stat(path.join(directory, files[kind])).catch(() => null);
    if (!info?.isFile()) throw new ReleaseFolderError(`The folder ${directory} has no file ${files[kind]}.`);
    sizes[kind] = info.size;
  }
  const tag = `agent-v${version}`;
  try {
    if (assetKinds.some(kind => sizes[kind] > releaseImportLimits[kind])) throw fail('tooLarge');
    const read = kind => readFile(path.join(directory, files[kind]));
    const [recordBytes, manifestBytes, signatureBytes] = await Promise.all([read('record'), read('manifest'), read('signature')]);
    const open = async kind => Readable.toWeb(createReadStream(path.join(directory, files[kind])));
    const outcome = await importOne(database, { source: 'folder', tag, version, fingerprint: null, recordBytes, manifestBytes, signatureBytes, open, storage, publicKeyPem, clock, holder: null });
    return { version, releaseId: outcome.releaseId, status: outcome.status };
  } catch (error) {
    if (!(error instanceof ReleaseImportFailure)) throw error;
    await writeImportRow(database, { tag, source: 'folder', version, status: 'failed', reason: error.reason, attemptedAt: clock() });
    throw new ReleaseFolderError(`Agent ${version} was not imported: ${releaseImportReasonText[error.reason]}`);
  }
}

/**
 * The response of one stored file: its chunks in order, each checked for
 * presence, length and SHA-256 while it streams. A missing or changed chunk
 * aborts the response. `file` is a row of agent_release_files.
 */
export function streamReleaseFile(storage, file) {
  const chunks = typeof file.chunks === 'string' ? JSON.parse(file.chunks) : file.chunks;
  let index = 0, reader = null, hash = null, received = 0;
  const release = async () => { if (reader) { await reader.cancel().catch(() => {}); reader = null; } };
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        for (;;) {
          if (!reader) {
            if (index === chunks.length) { controller.close(); return; }
            const object = await storage.get(releaseChunkKey(chunks[index].sha256));
            if (!object?.body) throw new Error('A stored chunk of the agent release is missing.');
            reader = object.body.getReader();
            hash = createHash('sha256');
            received = 0;
          }
          const { done, value } = await reader.read();
          if (done) {
            reader = null;
            if (received !== chunks[index].size || hash.digest('hex') !== chunks[index].sha256) throw new Error('A stored chunk of the agent release does not match its SHA-256.');
            index++;
            continue;
          }
          received += value.byteLength;
          if (received > chunks[index].size) throw new Error('A stored chunk of the agent release is too long.');
          hash.update(value);
          controller.enqueue(value);
          return;
        }
      } catch (error) {
        await release();
        controller.error(error);
      }
    },
    async cancel() { await release(); },
  });
  return new Response(stream, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(file.size), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
