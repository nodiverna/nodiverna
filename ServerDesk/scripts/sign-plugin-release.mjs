import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { devReleaseChangelog, validateReleaseChangelog } from './release-changelog.mjs';
import { baseVersion, isDevVersion } from '../runtime/release-version.mjs';
import { pluginManifestProblem, pluginReleasePartSize } from '../runtime/plugin-release-verify.mjs';
import { pluginPaths } from './plugin-release.mjs';

// Signs one plugin release (docs/agent-plugins.md, "CI and signing"). Node
// built-ins only: the sign job of .github/workflows/plugin-release.yml runs it
// without a package install, with the publisher key in the file that
// SERVERDESK_RELEASE_KEY_FILE names.
//   SERVERDESK_RELEASE_KEY_FILE=<key.pem> node scripts/sign-plugin-release.mjs --plugin dhcp
// It reads .build/plugin-<name>-artifact.json from scripts/build-plugin.mjs,
// hashes the published EXE again, builds the path-form manifest with the
// changelog of agent/plugins/<name>/changelogs/<version>.json and writes the
// signed record .build/plugin-<name>-release.json. Without a key the record
// stays unsigned and scripts/plugin-release.mjs assets refuses it. A dev build
// (X.Y.Z-dev.<sha7>) takes changelogs/X.Y.Z.json of its base when that file
// exists and is valid, else one generated line (devReleaseChangelog).

const root = fileURLToPath(new URL('..', import.meta.url));
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

/**
 * The manifest object of a plugin release, checked by pluginManifestProblem.
 * target is the detection id of the artifact; role repeats it, because
 * deployed agents (agent/v3/PluginHost.cs) require role and ignore target.
 */
export function pluginReleaseManifest({ name, artifact, parts, changelog, createdAt }) {
  const manifest = {
    kind: 'plugin', name, target: artifact.target, role: artifact.target, version: artifact.version, minAgentVersion: artifact.minAgentVersion, protocolVersion: 1,
    os: artifact.os, arch: 'x64', capabilities: artifact.capabilities,
    exe: { path: artifact.exe.path, sha256: artifact.exe.sha256, size: artifact.exe.size, ...(parts.length ? { parts } : {}) },
    changelog, createdAt: new Date(createdAt).toISOString(),
  };
  const problem = pluginManifestProblem(manifest);
  if (problem) throw new Error(`The plugin manifest is not valid: ${problem}`);
  return manifest;
}

function signPlugin(name, env) {
  const paths = pluginPaths(name);
  let artifact;
  try { artifact = JSON.parse(fs.readFileSync(path.join(root, paths.artifact), 'utf8')); } catch { throw new Error(`${paths.artifact} is missing or not valid JSON. Run scripts/build-plugin.mjs --plugin ${name} first.`); }
  if (artifact?.name !== name) throw new Error(`${paths.artifact} names the plugin ${artifact?.name}, not ${name}.`);
  const bytes = fs.readFileSync(path.join(root, paths.publish, paths.exe));
  // Hash the actual file before its metadata go into the signed manifest.
  if (bytes.length !== artifact.exe?.size || sha256(bytes) !== artifact.exe?.sha256) throw new Error(`${paths.exe} does not match ${paths.artifact}.`);
  const parts = [];
  if (bytes.length > pluginReleasePartSize) {
    for (let offset = 0, index = 1; offset < bytes.length; offset += pluginReleasePartSize, index++) {
      const slice = bytes.subarray(offset, Math.min(offset + pluginReleasePartSize, bytes.length));
      parts.push({ path: `${artifact.exe.path}.part${index}`, sha256: sha256(slice), size: slice.length });
    }
  }
  let changelog;
  if (isDevVersion(artifact.version)) {
    let text = null;
    try { text = fs.readFileSync(path.join(root, paths.changelogs, `${baseVersion(artifact.version)}.json`), 'utf8'); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    changelog = devReleaseChangelog(text, artifact.version);
  } else {
    let notes;
    try { notes = JSON.parse(fs.readFileSync(path.join(root, paths.changelogs, `${artifact.version}.json`), 'utf8')); } catch {
      throw new Error(`Add ${paths.changelogs}/${artifact.version}.json with version, features and fixes before publishing a new plugin release.`);
    }
    changelog = validateReleaseChangelog(notes, artifact.version);
  }
  const previous = (() => { try { return JSON.parse(fs.readFileSync(path.join(root, paths.record), 'utf8')); } catch { return null; } })();
  // Signing the same EXE again keeps its release identity and time.
  const same = previous?.name === name && previous.version === artifact.version && previous.sha256 === artifact.exe.sha256;
  const createdAt = same && Number.isSafeInteger(previous.createdAt) ? previous.createdAt : Date.now();
  const id = same && /^[0-9a-f-]{36}$/i.test(previous.id) ? previous.id : crypto.randomUUID();
  const manifestObject = pluginReleaseManifest({ name, artifact, parts, changelog, createdAt });
  const manifest = JSON.stringify(manifestObject);
  if (Buffer.byteLength(manifest, 'utf8') > 8192) throw new Error('The signed plugin manifest including the release notes exceeds 8192 bytes. Shorten the release notes.');
  const record = { id, name, version: artifact.version, manifest, sha256: artifact.exe.sha256, size: artifact.exe.size, createdAt };
  if (env.SERVERDESK_RELEASE_KEY_FILE) {
    const key = crypto.createPrivateKey(fs.readFileSync(env.SERVERDESK_RELEASE_KEY_FILE));
    const pinned = crypto.createPublicKey(fs.readFileSync(path.join(root, 'agent/v3/release-public.pem')));
    const signature = crypto.sign('sha256', Buffer.from(manifest, 'utf8'), { key, dsaEncoding: 'der' }).toString('base64');
    if (!crypto.verify('sha256', Buffer.from(manifest, 'utf8'), pinned, Buffer.from(signature, 'base64'))) throw new Error('The release signing key does not match the pinned publisher key.');
    record.signature = signature;
  }
  fs.writeFileSync(path.join(root, paths.record), JSON.stringify(record, null, 2) + '\n');
  console.log(JSON.stringify({ name, version: record.version, size: record.size, sha256: record.sha256, parts: parts.length, signing: record.signature ? 'offline-verified' : 'unsigned' }));
}

const direct = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct) {
  try {
    const { values } = parseArgs({ args: process.argv.slice(2), options: { plugin: { type: 'string' } } });
    if (!values.plugin) throw new Error('Usage: node scripts/sign-plugin-release.mjs --plugin <name>');
    signPlugin(values.plugin, process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
