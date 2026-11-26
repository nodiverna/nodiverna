import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { crc32, deflateRawSync } from 'node:zlib';
import { agentReleaseFiles, agentReleasePartEntries, agentReleasePartSize, verifyAgentRelease } from '../runtime/agent-release-verify.mjs';

// A throwaway test publisher for the signed update path. It never changes the
// runtime configuration: the pin of a portal stays a build-time constant.
//   pin --key <file>       creates a P-256 key at <file> once and pins its public
//                          key in this ServerDesk/ tree: lib/release-publisher.json,
//                          agent/v3/release-public.pem and the installer scripts
//                          (scripts/package-agent-v3.mjs). Only for a throwaway
//                          copy of the tree: a tree inside a git work tree is
//                          refused unless SERVERDESK_TEST_PUBLISHER_COPY names it
//                          (pnpm test:http sets it for its copy), and
//                          tests/repo/release-publisher-pin.mjs fails on a committed test pin.
//   release --key <file> --out <dir> [--version X.Y.Z] [--exe-size <bytes>]
//                          writes a synthetic release folder with the five asset
//                          names of the CI, signed with the key. It imports with
//                          selfhost.mjs import-release on a portal pinned to that key.
// Both commands refuse a key file below a .data/ directory and a key whose
// public key is the production publisher, so the production key
// (.data/release-private.pem) cannot be used by mistake.

const root = fileURLToPath(new URL('..', import.meta.url));
const usage = 'Usage: node scripts/test-publisher.mjs pin --key <file> | release --key <file> --out <dir> [--version X.Y.Z] [--exe-size <bytes>]';
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const testPublisherWarning = 'This tree now trusts a test publisher. Never commit it.';
/** The default EXE size: one byte over 20 MiB, so the EXE has two parts. */
export const defaultExeSize = agentReleasePartSize + 1;

/**
 * The SHA-256 of the DER SubjectPublicKeyInfo of the production publisher key:
 * the one source for the committed pin (tests/repo/release-publisher-pin.mjs) and
 * the key refusal. A fork changes it together with its pin.
 */
export const productionPublisherFingerprint = '01a31e1fed62d88f179c7e8797a6745d5e41aa91c8f3497c02f345812e7c1d85';
/** The mark of a throwaway copy: its value must resolve to the tree that pin rewrites. */
export const testPublisherCopyVariable = 'SERVERDESK_TEST_PUBLISHER_COPY';

/** An error with an English message for the operator; the CLI exits with 1. */
export class TestPublisherError extends Error {}

/** Refuses a key file below any .data/ directory (the place of the production key). */
export function assertTestKeyPath(file) {
  if (typeof file !== 'string' || !file) throw new TestPublisherError(usage);
  const parts = path.resolve(file).split(/[\\/]+/);
  if (parts.includes('.data')) throw new TestPublisherError(`${file} is below a .data/ directory. The test publisher never uses the production key .data/release-private.pem; pass a key file outside .data/.`);
  return path.resolve(file);
}

/** The SHA-256 fingerprint of a public key: the hash of its DER SubjectPublicKeyInfo. */
export function publisherFingerprint(publicKey) {
  return crypto.createHash('sha256').update(crypto.createPublicKey(publicKey).export({ type: 'spki', format: 'der' })).digest('hex');
}

/** Whether `tree` or one of its parent directories has a .git entry (a directory or a file). */
function inGitWorkTree(tree) {
  for (let directory = path.resolve(tree); ; directory = path.dirname(directory)) {
    if (existsSync(path.join(directory, '.git'))) return true;
    if (path.dirname(directory) === directory) return false;
  }
}

const sameDirectory = (left, right) => { try { return realpathSync(left) === realpathSync(right); } catch { return false; } };

/**
 * Refuses a tree inside a git work tree: pin there would rewrite the committed
 * pin. A throwaway copy inside a work tree (the Windows copy of pnpm test:http
 * in .http-test-copy/) passes only when `env` names exactly this tree.
 */
export function assertThrowawayTree(tree, env = process.env) {
  if (!inGitWorkTree(tree)) return;
  const mark = env[testPublisherCopyVariable];
  if (typeof mark === 'string' && mark && sameDirectory(mark, tree)) return;
  throw new TestPublisherError(`${path.resolve(tree)} is a git checkout. pin rewrites the committed publisher pin, so it runs only in a throwaway copy: use pnpm test:http.`);
}

/** Refuses the production publisher key; `fingerprint` is injectable for tests. */
export function assertNotProductionKey(file, privateKey, fingerprint = productionPublisherFingerprint) {
  if (publisherFingerprint(crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' })) === fingerprint) throw new TestPublisherError(`${file} holds the production publisher key. The test publisher never uses it; pass a throwaway key file.`);
}

function readKey(file) {
  try { return crypto.createPrivateKey(readFileSync(file)); } catch { throw new TestPublisherError(`${file} is not a readable private key.`); }
}

/**
 * pin: the key at `key` (created with mode 0600 when it is missing) becomes the
 * publisher of the tree at `tree`. Returns the fingerprint. The checks of the
 * key path, the tree and an existing key run before anything is written.
 */
export function pinTestPublisher({ key, tree = root, env = process.env, productionFingerprint = productionPublisherFingerprint }) {
  const file = assertTestKeyPath(key);
  assertThrowawayTree(tree, env);
  if (existsSync(file)) assertNotProductionKey(key, readKey(file), productionFingerprint);
  else {
    mkdirSync(path.dirname(file), { recursive: true });
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    writeFileSync(file, privateKey, { flag: 'wx', mode: 0o600 });
  }
  const publicKey = crypto.createPublicKey(readKey(file)).export({ type: 'spki', format: 'pem' }).toString();
  if (crypto.createPublicKey(publicKey).asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new TestPublisherError(`${file} is not a P-256 key.`);
  writeFileSync(path.join(tree, 'lib', 'release-publisher.json'), JSON.stringify({ publicKey }, null, 2) + '\n');
  writeFileSync(path.join(tree, 'agent', 'v3', 'release-public.pem'), publicKey);
  const generated = spawnSync(process.execPath, [path.join(tree, 'scripts', 'package-agent-v3.mjs')], { cwd: tree, encoding: 'utf8' });
  if (generated.error || generated.status !== 0) throw new TestPublisherError(`scripts/package-agent-v3.mjs failed: ${(generated.stderr || generated.error?.message || '').trim()}`);
  return publisherFingerprint(publicKey);
}

/** A ZIP with one deflated file dated 1980-01-01, written with Node built-ins only. */
function zipOne(name, bytes) {
  const data = deflateRawSync(bytes, { level: 1 }), file = Buffer.from(name, 'utf8'), crc = crc32(bytes);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8); local.writeUInt16LE(0x21, 12);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(file.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10); central.writeUInt16LE(0x21, 14);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(file.length, 28);
  const directoryOffset = local.length + file.length + data.length, directorySize = central.length + file.length;
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(directorySize, 12); end.writeUInt32LE(directoryOffset, 16);
  return Buffer.concat([local, file, data, central, file, end]);
}

/**
 * release: a complete, signed synthetic release folder in `out`, checked with
 * verifyAgentRelease against the key's own public key.
 * @returns {{ version: string, id: string, directory: string, files: Record<string, string> }}
 */
export function writeTestRelease({ key, out, version, exeSize = defaultExeSize, tree = root, now = Date.now(), productionFingerprint = productionPublisherFingerprint }) {
  const file = assertTestKeyPath(key);
  if (!existsSync(file)) throw new TestPublisherError(`${file} does not exist. Create it with: node scripts/test-publisher.mjs pin --key ${key}`);
  assertNotProductionKey(key, readKey(file), productionFingerprint);
  if (!out) throw new TestPublisherError(usage);
  const release = version ?? /<Version>([^<]*)<\/Version>/.exec(readFileSync(path.join(tree, 'agent', 'v3', 'ServerDesk.Agent.csproj'), 'utf8'))?.[1];
  if (!release || !semver.test(release)) throw new TestPublisherError(`The version "${release}" must be X.Y.Z.`);
  if (!Number.isSafeInteger(exeSize) || exeSize < 1 || exeSize > 250000000) throw new TestPublisherError('--exe-size must be a whole number of bytes from 1 to 250000000.');
  const privateKey = readKey(file), publicKeyPem = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
  const names = agentReleaseFiles(release);
  const exe = crypto.randomBytes(exeSize), zip = zipOne('ServerDesk.Agent.exe', exe);
  if (zip.length > 104857600) throw new TestPublisherError('The ZIP of the test release exceeds 100 MiB. Use a smaller --exe-size.');
  const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const zipParts = agentReleasePartEntries(zip, names.zip), exeParts = agentReleasePartEntries(exe, names.exe);
  const manifest = JSON.stringify({
    version: release, protocolVersion: 3, minProtocolVersion: 3, os: ['Windows Server 2022', 'Windows Server 2025', 'Windows 11 Pro', 'Windows 11 Enterprise'], arch: 'x64',
    path: `/downloads/${names.zip}`, sha256: sha256(zip), size: zip.length, layout: 'single-exe',
    exe: { path: `/downloads/${names.exe}`, sha256: sha256(exe), size: exe.length, ...(exeParts.length ? { parts: exeParts.map(({ path: entry, sha256: hash, size }) => ({ path: entry, sha256: hash, size })) } : {}) },
    ...(zipParts.length ? { parts: zipParts.map(({ path: entry, sha256: hash, size }) => ({ path: entry, sha256: hash, size })) } : {}),
    changelog: { features: [`Test release ${release} of a throwaway test publisher`], fixes: [] }, createdAt: new Date(now).toISOString(),
  });
  if (manifest.length > 8192) throw new TestPublisherError('The manifest exceeds 8192 characters.');
  const signature = crypto.sign('sha256', Buffer.from(manifest), { key: privateKey, dsaEncoding: 'der' }).toString('base64');
  const record = { id: crypto.randomUUID(), version: release, manifest, signature, sha256: sha256(zip), size: zip.length, createdAt: now };
  verifyAgentRelease({ record, files: { zip, exe }, publicKeyPem, version: release });
  mkdirSync(out, { recursive: true });
  const contents = { zip, exe, record: JSON.stringify(record, null, 2) + '\n', manifest, signature };
  for (const [kind, content] of Object.entries(contents)) writeFileSync(path.join(out, names[kind]), content);
  return { version: release, id: record.id, directory: path.resolve(out), files: names };
}

function cli(argv) {
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: { key: { type: 'string' }, out: { type: 'string' }, version: { type: 'string' }, 'exe-size': { type: 'string' } } });
  const [command, ...rest] = positionals;
  if (rest.length || !values.key) throw new TestPublisherError(usage);
  if (command === 'pin' && !values.out && !values.version && !values['exe-size']) {
    const fingerprint = pinTestPublisher({ key: values.key });
    console.log(`Test publisher public-key SHA-256: ${fingerprint}`);
    console.warn(testPublisherWarning);
    return;
  }
  if (command === 'release' && values.out) {
    const exeSize = values['exe-size'] === undefined ? defaultExeSize : /^\d+$/.test(values['exe-size']) ? Number(values['exe-size']) : NaN;
    console.log(JSON.stringify(writeTestRelease({ key: values.key, out: values.out, version: values.version, exeSize })));
    return;
  }
  throw new TestPublisherError(usage);
}

const direct = process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (direct) {
  try { cli(process.argv.slice(2)); } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
