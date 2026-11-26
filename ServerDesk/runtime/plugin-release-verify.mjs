import crypto from 'node:crypto';
import { isBaseVersion, isReleaseVersion } from './release-version.mjs';

// The one check of a signed plugin release record from the CI
// (scripts/sign-plugin-release.mjs, .github/workflows/plugin-release.yml). The
// CLI scripts/plugin-release.mjs (verify, assets) and the portal import of
// plugin releases from GitHub or a folder (runtime/release-import.mjs) both call
// verifyPluginRelease, so the two can never accept different records.
// Plain JavaScript with Node built-ins only: the image copies runtime/ for the
// offline CLI scripts/selfhost.mjs, and the release job of the workflow runs it
// without a package install. runtime/release-schema.mjs builds the zod schema of
// the portal (pluginManifestSchema) from the same constants.

const publicKeyFile = 'agent/v3/release-public.pem';
const digest = /^[a-f0-9]{64}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const recordKeys = ['createdAt', 'id', 'manifest', 'name', 'sha256', 'signature', 'size', 'version'];
const manifestKeys = ['arch', 'capabilities', 'changelog', 'createdAt', 'exe', 'kind', 'minAgentVersion', 'name', 'os', 'protocolVersion', 'role', 'version'];
/** The one optional manifest key: target. Deployed agents ignore it and still require role. */
const optionalManifestKeys = ['target'];
const isoDate = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/**
 * The detection ids of lib/extensions.ts (detectionCatalog), in catalog order,
 * as plain data so the offline CLI can check a plugin manifest without the
 * TypeScript catalog. A manifest's target (or, in a role-only manifest, its role)
 * must be one of them. tests/lib/plugin-release-verify.mjs keeps both lists equal.
 */
export const extensionTargetIds = Object.freeze([
  'ad-ds', 'dhcp', 'dns', 'file-server', 'dfs', 'print', 'iis', 'hyper-v', 'rds', 'wsus', 'ad-cs', 'ad-fs', 'npas', 'remote-access', 'wds', 'failover-clustering',
  'sql-server', 'exchange', 'sharepoint', 'veeam-br', 'veeam-agent', 'entra-connect',
]);
export const pluginNamePattern = /^[a-z][a-z0-9-]{1,31}$/;
export const pluginCapabilityPattern = /^[a-z][a-z0-9-]{1,63}$/;
/** The largest plugin EXE, the largest part of it, the most parts and the largest manifest in bytes. */
export const pluginLimits = Object.freeze({ exe: 104857600, part: 20971520, parts: 6, manifest: 8192 });
/** The size of one part file of a plugin EXE, the same as for agent releases. */
export const pluginReleasePartSize = 20 * 1024 * 1024;
/** The download path of a plugin EXE: one file below /downloads/, named after the plugin and its version. */
export const pluginExePath = (name, version) => `/downloads/ServerDesk-Plugin-${name}-${version}-win-x64.exe`;

/** The release file names of one plugin version: the EXE, the signed record, the manifest and the signature. */
export const pluginReleaseFiles = (name, version) => ({
  exe: `ServerDesk-Plugin-${name}-${version}-win-x64.exe`,
  record: `ServerDesk-Plugin-${name}-${version}-release.json`,
  manifest: `ServerDesk-Plugin-${name}-${version}-manifest.json`,
  signature: `ServerDesk-Plugin-${name}-${version}-manifest.sig`,
});

/**
 * A refused plugin record. `reason` is the import failure key: signatureInvalid
 * for the signature, hashMismatch for an EXE that does not match the manifest,
 * manifestInvalid for everything else.
 */
export class PluginReleaseError extends Error {
  constructor(message, reason) {
    super(message);
    this.name = 'PluginReleaseError';
    this.reason = reason;
  }
}
const invalid = message => new PluginReleaseError(message, 'manifestInvalid');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys, optional = []) => isObject(value) && Object.keys(value).filter(key => !optional.includes(key)).sort().join(',') === [...keys].sort().join(',');
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const size = (value, max) => Number.isSafeInteger(value) && value > 0 && value <= max;

function changelogProblem(changelog) {
  if (!exactKeys(changelog, ['features', 'fixes'])) return 'The changelog must have exactly features and fixes.';
  for (const list of [changelog.features, changelog.fixes]) {
    if (!Array.isArray(list) || list.length > 10 || list.some(entry => typeof entry !== 'string' || !entry.trim() || entry.trim().length > 200)) return 'The changelog lists at most 10 entries of at most 200 characters.';
  }
  return changelog.features.length + changelog.fixes.length > 0 ? null : 'The changelog needs at least one feature or fix.';
}

/**
 * The first problem of a parsed plugin manifest, or null. The same rules as
 * pluginManifestSchema in runtime/release-schema.mjs, without a dependency.
 * @param {any} manifest
 * @returns {string | null}
 */
export function pluginManifestProblem(manifest) {
  if (!exactKeys(manifest, manifestKeys, optionalManifestKeys)) return 'The plugin manifest must have exactly the keys ' + manifestKeys.join(', ') + ' and an optional ' + optionalManifestKeys.join(', ') + '.';
  if (manifest.kind !== 'plugin') return 'The manifest is not a plugin manifest.';
  if (typeof manifest.name !== 'string' || !pluginNamePattern.test(manifest.name)) return 'The plugin name is not valid.';
  // A manifest with target: the target is a detection id and role repeats it, because deployed agents require role.
  // A role-only manifest without target: role is the detection id.
  if (Object.hasOwn(manifest, 'target')) {
    if (!extensionTargetIds.includes(manifest.target)) return 'The plugin target is not an id of the detection catalog.';
    if (manifest.role !== manifest.target) return 'The plugin role must equal the plugin target.';
  } else if (!extensionTargetIds.includes(manifest.role)) return 'The plugin role is not an id of the detection catalog.';
  // The version may be a dev build (X.Y.Z-dev.<sha7>); the minimum agent version is always X.Y.Z.
  if (!isReleaseVersion(manifest.version) || !isBaseVersion(manifest.minAgentVersion)) return 'The plugin version must be X.Y.Z or X.Y.Z-dev.<sha7>, and the minimum agent version must be X.Y.Z.';
  if (manifest.protocolVersion !== 1) return 'The plugin protocol version must be 1.';
  if (!Array.isArray(manifest.os) || manifest.os.length < 1 || manifest.os.length > 4 || manifest.os.some(entry => !text(entry, 64))) return 'The plugin manifest names 1 to 4 operating systems.';
  if (manifest.arch !== 'x64') return 'The plugin architecture must be x64.';
  const capabilities = manifest.capabilities;
  if (!Array.isArray(capabilities) || capabilities.length < 1 || capabilities.length > 32 || capabilities.some(entry => typeof entry !== 'string' || !pluginCapabilityPattern.test(entry)) || new Set(capabilities).size !== capabilities.length) return 'The plugin capabilities must be 1 to 32 unique names.';
  const exe = manifest.exe;
  if (!isObject(exe) || Object.keys(exe).some(key => !['path', 'sha256', 'size', 'parts'].includes(key)) || !['path', 'sha256', 'size'].every(key => Object.hasOwn(exe, key))) return 'The plugin EXE entry must have path, sha256, size and optional parts.';
  const expected = pluginExePath(manifest.name, manifest.version);
  if (exe.path !== expected) return `The plugin EXE must have the path ${expected}.`;
  if (typeof exe.sha256 !== 'string' || !digest.test(exe.sha256) || !size(exe.size, pluginLimits.exe)) return 'The plugin EXE needs a SHA-256 and a size of at most 100 MiB.';
  if (exe.parts !== undefined) {
    if (!Array.isArray(exe.parts) || exe.parts.length < 1 || exe.parts.length > pluginLimits.parts) return 'A plugin EXE has 1 to 6 parts.';
    for (const [index, part] of exe.parts.entries()) {
      if (!exactKeys(part, ['path', 'sha256', 'size']) || part.path !== `${expected}.part${index + 1}` || typeof part.sha256 !== 'string' || !digest.test(part.sha256) || !size(part.size, pluginLimits.part)) return `Part ${index + 1} of the plugin EXE is not valid.`;
    }
    if (exe.parts.reduce((total, part) => total + part.size, 0) !== exe.size) return 'The part sizes must add up to the EXE size.';
  }
  const notes = changelogProblem(manifest.changelog);
  if (notes) return notes;
  if (typeof manifest.createdAt !== 'string' || !isoDate.test(manifest.createdAt) || Number.isNaN(Date.parse(manifest.createdAt))) return 'The plugin manifest needs createdAt as an ISO time.';
  return null;
}

/**
 * Checks a signed plugin record: the exact keys, the signature over the exact
 * manifest bytes against the given public key, the manifest rules, name and
 * version, the expected EXE path and, with `files.exe`, the size and SHA-256 of
 * the EXE and of each 20 MiB part. Every failure is a PluginReleaseError with its reason.
 * @param {{ record: any, files?: { exe?: Buffer }, publicKeyPem: string | Buffer, name: string, version: string }} input
 * @returns {any} the parsed manifest
 */
export function verifyPluginRelease({ record, files, publicKeyPem, name, version }) {
  if (!isObject(record)) throw invalid('The plugin release record is not an object.');
  if (typeof record.signature !== 'string' || !record.signature) throw invalid('The plugin release record has no signature.');
  if (!exactKeys(record, recordKeys)) throw invalid('The plugin release record must have exactly the keys id, name, version, manifest, signature, sha256, size and createdAt.');
  if (record.name !== name || record.version !== version) throw invalid(`The plugin release record is ${record.name} ${record.version}, not ${name} ${version}.`);
  if (!pluginNamePattern.test(name) || !isReleaseVersion(version) || typeof record.id !== 'string' || !uuid.test(record.id) || typeof record.manifest !== 'string'
    || Buffer.byteLength(record.manifest, 'utf8') > pluginLimits.manifest || typeof record.sha256 !== 'string' || !digest.test(record.sha256)
    || !size(record.size, pluginLimits.exe) || !Number.isSafeInteger(record.createdAt) || record.createdAt < 1) {
    throw invalid('The plugin release record does not match its manifest.');
  }
  let valid = false;
  try {
    const signature = Buffer.from(record.signature, 'base64');
    // Canonical base64 of at most 256 characters, as the portal accepts it.
    valid = record.signature.length <= 256 && signature.toString('base64') === record.signature
      && crypto.verify('sha256', Buffer.from(record.manifest, 'utf8'), crypto.createPublicKey(publicKeyPem), signature);
  } catch { valid = false; }
  if (!valid) throw new PluginReleaseError(`The plugin release signature does not match ${publicKeyFile}.`, 'signatureInvalid');
  let manifest;
  try { manifest = JSON.parse(record.manifest); } catch { throw invalid('The plugin release manifest is not valid JSON.'); }
  const problem = pluginManifestProblem(manifest);
  if (problem) throw invalid(problem);
  if (manifest.name !== name || manifest.version !== version) throw invalid(`The plugin release manifest is ${manifest.name} ${manifest.version}, not ${name} ${version}.`);
  if (manifest.exe.sha256 !== record.sha256 || manifest.exe.size !== record.size) throw invalid('The plugin release record does not match its manifest.');
  if (files !== undefined) {
    const bytes = files.exe, names = pluginReleaseFiles(name, version);
    if (!Buffer.isBuffer(bytes) || bytes.length !== manifest.exe.size || sha256(bytes) !== manifest.exe.sha256) throw new PluginReleaseError(`${names.exe} does not match the signed manifest.`, 'hashMismatch');
    (manifest.exe.parts ?? []).forEach((part, index) => {
      const slice = bytes.subarray(index * pluginReleasePartSize, Math.min((index + 1) * pluginReleasePartSize, bytes.length));
      if (part.size !== slice.length || part.sha256 !== sha256(slice)) throw new PluginReleaseError(`${names.exe}.part${index + 1} is not the matching 20 MiB slice of ${names.exe}.`, 'hashMismatch');
    });
  }
  return manifest;
}
