import crypto from 'node:crypto';
import { releaseManifestForm } from './release-manifest.mjs';
import { isReleaseVersion } from './release-version.mjs';

// The one check of a signed agent release record from the CI
// (scripts/sign-agent-release.mjs, .github/workflows/agent-release.yml). The
// CLI scripts/agent-release.mjs (verify, assets) and the portal import of
// releases from GitHub or a folder (runtime/release-import.mjs) both call
// verifyAgentRelease, so the two can never accept different records.
// Plain JavaScript in runtime/, because the image copies runtime/ for the
// offline CLI scripts/selfhost.mjs.

const publicKeyFile = 'agent/v3/release-public.pem';
const digest = /^[a-f0-9]{64}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const recordKeys = ['createdAt', 'id', 'manifest', 'sha256', 'signature', 'size', 'version'];

/** The size of one part file of the build (scripts/build-agent-v3.mjs). */
export const agentReleasePartSize = 20 * 1024 * 1024;

/**
 * The part entries of one release file: none up to 20 MiB, else one entry per
 * consecutive 20 MiB slice with its path below /downloads/, size and SHA-256.
 * The build and the test publisher describe the parts; no part file exists.
 * @param {Buffer} bytes
 * @param {string} name the file name, for example ServerDesk-Agent-4.13.0-win-x64.exe
 */
export function agentReleasePartEntries(bytes, name) {
  if (bytes.length <= agentReleasePartSize) return [];
  return Array.from({ length: Math.ceil(bytes.length / agentReleasePartSize) }, (_, index) => {
    const slice = bytes.subarray(index * agentReleasePartSize, Math.min((index + 1) * agentReleasePartSize, bytes.length));
    return { path: `/downloads/${name}.part${index + 1}`, size: slice.length, sha256: sha256(slice) };
  });
}

/** The release file names for one agent version (X.Y.Z or X.Y.Z-dev.<sha7>). */
export const agentReleaseFiles = version => ({
  zip: `ServerDesk-Agent-${version}-win-x64.zip`,
  exe: `ServerDesk-Agent-${version}-win-x64.exe`,
  record: `ServerDesk-Agent-${version}-release.json`,
  manifest: `ServerDesk-Agent-${version}-manifest.json`,
  signature: `ServerDesk-Agent-${version}-manifest.sig`,
});

/**
 * A refused record. `reason` is the import failure key: signatureInvalid for
 * the signature, hashMismatch for a file that does not match the manifest,
 * manifestInvalid for everything else.
 */
export class AgentReleaseError extends Error {
  constructor(message, reason) {
    super(message);
    this.name = 'AgentReleaseError';
    this.reason = reason;
  }
}
const invalid = message => new AgentReleaseError(message, 'manifestInvalid');

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const isSize = (value, max) => Number.isSafeInteger(value) && value > 0 && value <= max;
const partsMatch = (parts, size) => parts === undefined || (Array.isArray(parts) && parts.reduce((total, part) => total + part?.size, 0) === size);

/**
 * The file entries of a path-form manifest with the path each must have:
 * the ZIP and its parts, then the EXE and its parts, numbered from 1.
 */
function expectedPaths(manifest, version) {
  const names = agentReleaseFiles(version);
  const entries = [[manifest, `/downloads/${names.zip}`]];
  (manifest.parts ?? []).forEach((part, index) => entries.push([part, `/downloads/${names.zip}.part${index + 1}`]));
  entries.push([manifest.exe, `/downloads/${names.exe}`]);
  (manifest.exe.parts ?? []).forEach((part, index) => entries.push([part, `/downloads/${names.exe}.part${index + 1}`]));
  return entries;
}

/**
 * Checks a signed record from scripts/sign-agent-release.mjs: the exact keys,
 * the signature against the given public key, the record against its manifest,
 * the path form with the expected file names and, with `files`, the ZIP and the
 * EXE against the manifest and each part against its 20 MiB slice of the file.
 * Every failure is an AgentReleaseError with its reason.
 * @param {{ record: any, files?: { zip?: Buffer, exe?: Buffer }, publicKeyPem: string | Buffer, version: string }} input
 * @returns {any} the parsed manifest
 */
export function verifyAgentRelease({ record, files, publicKeyPem, version }) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw invalid('The agent release record is not an object.');
  if (typeof record.signature !== 'string' || !record.signature) throw invalid('The agent release record has no signature.');
  if (Object.keys(record).sort().join(',') !== recordKeys.join(',')) {
    throw invalid('The agent release record must have exactly the keys id, version, manifest, signature, sha256, size and createdAt.');
  }
  if (record.version !== version) throw invalid(`The agent release record has version ${record.version}, not ${version}.`);
  // The checks of the portal on a stored release row (lib/server/agent/releases.ts).
  if (!isReleaseVersion(version) || typeof record.id !== 'string' || !uuid.test(record.id) || typeof record.manifest !== 'string' || record.manifest.length > 8192
    || typeof record.sha256 !== 'string' || !digest.test(record.sha256) || !isSize(record.size, 104857600) || !Number.isSafeInteger(record.createdAt) || record.createdAt < 1) {
    throw invalid('The agent release record does not match its manifest.');
  }
  let manifest;
  try { manifest = JSON.parse(record.manifest); } catch { throw invalid('The agent release record does not match its manifest.'); }
  if (!manifest || typeof manifest !== 'object' || manifest.version !== record.version || manifest.sha256 !== record.sha256 || manifest.size !== record.size
    || manifest.protocolVersion !== 3 || manifest.layout !== 'single-exe' || !manifest.exe || typeof manifest.exe !== 'object'
    || typeof manifest.exe.sha256 !== 'string' || !digest.test(manifest.exe.sha256) || !isSize(manifest.exe.size, 250000000)
    || !partsMatch(manifest.parts, manifest.size) || !partsMatch(manifest.exe.parts, manifest.exe.size)) {
    throw invalid('The agent release record does not match its manifest.');
  }
  let valid = false;
  try {
    const signature = Buffer.from(record.signature, 'base64');
    // Canonical base64 of at most 256 characters, as the portal accepts it.
    valid = record.signature.length <= 256 && signature.toString('base64') === record.signature
      && crypto.verify('sha256', Buffer.from(record.manifest), crypto.createPublicKey(publicKeyPem), signature);
  } catch { valid = false; }
  if (!valid) throw new AgentReleaseError(`The agent release signature does not match ${publicKeyFile}.`, 'signatureInvalid');
  // Only the path form is valid on every installation; the portal imports it as signed.
  let form;
  try { form = releaseManifestForm(manifest); } catch { throw invalid('The agent release manifest mixes file paths and URLs.'); }
  if (form !== 'path') throw invalid('The agent release manifest has the absolute form with URLs. Sign it again with scripts/sign-agent-release.mjs to get the path form.');
  for (const [entry, expected] of expectedPaths(manifest, version)) {
    if (entry.path !== expected) throw invalid(`The agent release manifest names ${JSON.stringify(entry.path)} where ${expected} is expected.`);
  }
  if (files !== undefined) {
    const names = agentReleaseFiles(version);
    for (const [kind, expected] of [['zip', manifest], ['exe', manifest.exe]]) {
      const bytes = files[kind];
      if (!Buffer.isBuffer(bytes) || bytes.length !== expected.size || sha256(bytes) !== expected.sha256) throw new AgentReleaseError(`${names[kind]} does not match the signed manifest.`, 'hashMismatch');
      // Each part is the consecutive 20 MiB slice that the build wrote, so the
      // ZIP and the EXE are enough to serve every path of the manifest.
      (expected.parts ?? []).forEach((part, index) => {
        const slice = bytes.subarray(index * agentReleasePartSize, Math.min((index + 1) * agentReleasePartSize, bytes.length));
        if (part.size !== slice.length || part.sha256 !== sha256(slice)) throw new AgentReleaseError(`${names[kind]}.part${index + 1} is not the matching 20 MiB slice of ${names[kind]}.`, 'hashMismatch');
      });
    }
  }
  return manifest;
}
