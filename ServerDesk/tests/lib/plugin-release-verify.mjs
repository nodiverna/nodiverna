// Plugin releases (docs/agent-plugins.md): the manifest schema of the portal
// (runtime/release-schema.mjs) and the shared check of a signed record
// (runtime/plugin-release-verify.mjs) with a throwaway P-256 publisher. Pure:
// no database, no network.
import '../support/register.mjs';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import test from 'node:test';
import { extensionTargetIds, pluginManifestSchema } from '../../runtime/release-schema.mjs';
import { extensionTargetIds as verifyTargetIds, PluginReleaseError, pluginManifestProblem, pluginReleaseFiles, pluginReleasePartSize, verifyPluginRelease } from '../../runtime/plugin-release-verify.mjs';

const { detectionCatalog } = await import('../../lib/extensions.ts');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' });
const foreignPem = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ type: 'spki', format: 'pem' });

/** The DHCP plugin manifest as the signing script builds it; `edit` changes it. */
function manifest(exe = Buffer.from('dhcp plugin exe 1.0.0'), edit = value => value) {
  const path = '/downloads/ServerDesk-Plugin-dhcp-1.0.0-win-x64.exe';
  const parts = exe.length > pluginReleasePartSize ? Array.from({ length: Math.ceil(exe.length / pluginReleasePartSize) }, (_, index) => {
    const slice = exe.subarray(index * pluginReleasePartSize, (index + 1) * pluginReleasePartSize);
    return { path: `${path}.part${index + 1}`, sha256: hash(slice), size: slice.length };
  }) : undefined;
  return edit({
    kind: 'plugin', name: 'dhcp', role: 'dhcp', version: '1.0.0', minAgentVersion: '4.16.0', protocolVersion: 1, os: ['Windows Server 2022', 'Windows Server 2025'], arch: 'x64',
    capabilities: ['dhcp-read'], exe: { path, sha256: hash(exe), size: exe.length, ...(parts ? { parts } : {}) },
    changelog: { features: ['Reads the DHCP server.'], fixes: [] }, createdAt: '2026-11-01T00:00:00.000Z',
  });
}
function record({ exe = Buffer.from('dhcp plugin exe 1.0.0'), edit, key = keys.privateKey, change = value => value } = {}) {
  const value = manifest(exe, edit), text = JSON.stringify(value);
  return change({ id: randomUUID(), name: 'dhcp', version: '1.0.0', manifest: text, signature: sign('sha256', Buffer.from(text), key).toString('base64'), sha256: value.exe.sha256, size: value.exe.size, createdAt: Date.UTC(2026, 10, 1) });
}
const reason = (input, expected, label) => assert.throws(() => verifyPluginRelease({ publicKeyPem, name: 'dhcp', version: '1.0.0', ...input }), error => error instanceof PluginReleaseError && error.reason === expected, label);
// Both rule sets: the schema of the portal and the dependency-free check of the CLI.
const accepted = value => [pluginManifestSchema.safeParse(value).success, pluginManifestProblem(value) === null];

test('the target ids of the plugin manifest are the ids of the detection catalog, in catalog order', () => {
  assert.deepEqual([...extensionTargetIds], detectionCatalog.map(entry => entry.id));
  assert.equal(extensionTargetIds.length, 22);
  assert.equal(verifyTargetIds, extensionTargetIds, 'the schema module re-exports the list of the CLI check');
});

test('a manifest names its target: role only, target with an equal role, and the refusals', () => {
  const withoutRole = Object.fromEntries(Object.entries(manifest()).filter(([key]) => key !== 'role'));
  const cases = {
    'a manifest with role only': [manifest(), true, null],
    'a role-only manifest whose role is a software id': [manifest(undefined, value => ({ ...value, role: 'sql-server' })), true, null],
    'target and an equal role': [manifest(undefined, value => ({ ...value, target: 'dhcp' })), true, null],
    'a software target with an equal role': [manifest(undefined, value => ({ ...value, target: 'veeam-agent', role: 'veeam-agent' })), true, null],
    'target without role': [{ ...withoutRole, target: 'dhcp' }, false, /must have exactly the keys/],
    'neither target nor role': [withoutRole, false, /must have exactly the keys/],
    'an unknown target': [manifest(undefined, value => ({ ...value, target: 'mail', role: 'mail' })), false, /^The plugin target is not an id of the detection catalog\.$/],
    'a target that is no string': [manifest(undefined, value => ({ ...value, target: null })), false, /^The plugin target is not an id of the detection catalog\.$/],
    'role differs from target': [manifest(undefined, value => ({ ...value, target: 'dns' })), false, /^The plugin role must equal the plugin target\.$/],
    'an unknown role with a valid target': [manifest(undefined, value => ({ ...value, target: 'dhcp', role: 'mail' })), false, /^The plugin role must equal the plugin target\.$/],
    'an unknown role without target': [manifest(undefined, value => ({ ...value, role: 'mail' })), false, /^The plugin role is not an id of the detection catalog\.$/],
    'target and another extra key': [manifest(undefined, value => ({ ...value, target: 'dhcp', targets: ['dhcp'] })), false, /must have exactly the keys/],
  };
  for (const [label, [value, ok, problem]] of Object.entries(cases)) {
    assert.deepEqual(accepted(value), [ok, ok], `${label}: the schema and the CLI check agree`);
    if (problem) assert.match(pluginManifestProblem(value), problem, label);
  }
  assert.equal(pluginManifestSchema.parse(manifest(undefined, value => ({ ...value, target: 'dhcp' }))).target, 'dhcp', 'the schema keeps target');
  assert.equal(Object.hasOwn(pluginManifestSchema.parse(manifest()), 'target'), false, 'a role-only manifest parses without target');
});

test('the schema accepts the DHCP manifest and refuses every malformed field, the same as the CLI check', () => {
  assert.deepEqual(accepted(manifest()), [true, true], 'the DHCP plugin manifest');
  const big = Buffer.alloc(pluginReleasePartSize + 5, 1);
  assert.deepEqual(accepted(manifest(big)), [true, true], 'an EXE above 20 MiB with its two parts');
  const refused = {
    'an absolute URL': value => ({ ...value, exe: { ...value.exe, path: undefined, url: 'https://portal.example/downloads/x.exe' } }),
    'a wrong path': value => ({ ...value, exe: { ...value.exe, path: '/downloads/ServerDesk-Plugin-dns-1.0.0-win-x64.exe' } }),
    'a path outside /downloads/': value => ({ ...value, exe: { ...value.exe, path: '/other/ServerDesk-Plugin-dhcp-1.0.0-win-x64.exe' } }),
    'a part size sum': value => ({ ...value, exe: { ...value.exe, parts: [{ path: `${value.exe.path}.part1`, sha256: value.exe.sha256, size: value.exe.size + 1 }] } }),
    'a bad name': value => ({ ...value, name: 'DHCP' }),
    'a bad capability': value => ({ ...value, capabilities: ['Dhcp Read'] }),
    'duplicate capabilities': value => ({ ...value, capabilities: ['dhcp-read', 'dhcp-read'] }),
    'protocolVersion 2': value => ({ ...value, protocolVersion: 2 }),
    'an unknown role': value => ({ ...value, role: 'mail' }),
    'another kind': value => ({ ...value, kind: 'agent' }),
    'an extra key': value => ({ ...value, extra: true }),
    'an EXE above 100 MiB': value => ({ ...value, exe: { ...value.exe, size: 104857601 } }),
    'no changelog entry': value => ({ ...value, changelog: { features: [], fixes: [] } }),
    'five operating systems': value => ({ ...value, os: ['a', 'b', 'c', 'd', 'e'] }),
  };
  for (const [label, edit] of Object.entries(refused)) assert.deepEqual(accepted(manifest(undefined, edit)), [false, false], label);
});

test('verifyPluginRelease accepts the signed record and names the reason of every refusal', () => {
  const exe = Buffer.from('dhcp plugin exe 1.0.0'), good = record({ exe });
  assert.equal(verifyPluginRelease({ record: good, files: { exe }, publicKeyPem, name: 'dhcp', version: '1.0.0' }).capabilities[0], 'dhcp-read');
  assert.deepEqual(pluginReleaseFiles('dhcp', '1.0.0'), { exe: 'ServerDesk-Plugin-dhcp-1.0.0-win-x64.exe', record: 'ServerDesk-Plugin-dhcp-1.0.0-release.json', manifest: 'ServerDesk-Plugin-dhcp-1.0.0-manifest.json', signature: 'ServerDesk-Plugin-dhcp-1.0.0-manifest.sig' });
  reason({ record: good, publicKeyPem: foreignPem }, 'signatureInvalid', 'a foreign key');
  reason({ record: { ...good, manifest: good.manifest.replace('Reads', 'Reads!') } }, 'signatureInvalid', 'a changed byte of the manifest');
  reason({ record: good, files: { exe: Buffer.from('dhcp plugin exe 1.0.X') } }, 'hashMismatch', 'a hash mismatch');
  reason({ record: good, files: { exe: Buffer.from('dhcp plugin exe 1.0.0 longer') } }, 'hashMismatch', 'a size mismatch');
  reason({ record: good, name: 'dns' }, 'manifestInvalid', 'a name mismatch');
  reason({ record: good, version: '1.0.1' }, 'manifestInvalid', 'a version mismatch');
  reason({ record: record({ edit: value => ({ ...value, name: 'dns', exe: { ...value.exe, path: '/downloads/ServerDesk-Plugin-dns-1.0.0-win-x64.exe' } }) }) }, 'manifestInvalid', 'a manifest of another plugin under this record');
  reason({ record: record({ change: value => ({ ...value, size: value.size + 1 }) }) }, 'manifestInvalid', 'a record that differs from its manifest');
  reason({ record: { ...good, extra: 1 } }, 'manifestInvalid', 'an extra record key');
  reason({ record: { ...good, signature: '' } }, 'manifestInvalid', 'no signature');
  reason({ record: record({ edit: value => ({ ...value, protocolVersion: 2 }) }) }, 'manifestInvalid', 'a signed manifest of protocol 2');
  const big = Buffer.alloc(pluginReleasePartSize + 5, 7), parted = record({ exe: big });
  assert.equal(verifyPluginRelease({ record: parted, files: { exe: big }, publicKeyPem, name: 'dhcp', version: '1.0.0' }).exe.parts.length, 2, 'the parts are the 20 MiB slices');
  const other = Buffer.from(big); other[pluginReleasePartSize + 1] = 9;
  reason({ record: parted, files: { exe: other } }, 'hashMismatch', 'a changed byte in the last part');
});
