import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { serverDeskRoot } from '../support/paths.mjs';

// The fixed npm advisories stay fixed (also zod, @azure/msal-node and fast-xml-parser
// (GHSA-474x-hrwr-fgx4) by minimum version, minimatch (GHSA-g3hv-75wg-m249) by an
// affected range with typescript-eslint on one shared version, for the app and the
// lint toolchain), and the one audit exception
// (braces, no fixed release) stays narrow and goes away once a fix exists.
// Fully offline: the online check is `pnpm check:audit` in the image workflow.
const root = serverDeskRoot;
const require = createRequire(import.meta.url);
// js-yaml is an existing ESLint dependency, not a new application dependency.
const yaml = createRequire(require.resolve('eslint/package.json'))('js-yaml');
const read = async name => readFile(path.join(root, name), 'utf8');
const manifest = JSON.parse(await read('package.json'));
const workspace = yaml.load(await read('pnpm-workspace.yaml'));
const lock = yaml.load(await read('pnpm-lock.yaml'));

const bracesAdvisory = 'GHSA-vfj7-8cjw-p6xm';
// Fixed advisories: a locked version at or below `upTo` is vulnerable.
const fixed = [
  { ghsa: 'GHSA-2464-fhr4-w9xw', packages: ['next', '@next/env', '@next/eslint-plugin-next', 'eslint-config-next'], upTo: '16.4.0' },
  { ghsa: 'GHSA-673q-mjm6-r5xr', packages: ['next', '@next/env', '@next/eslint-plugin-next', 'eslint-config-next'], upTo: '16.4.0' },
  { ghsa: 'GHSA-p3m5-59mp-jv5r', packages: ['next', '@next/env', '@next/eslint-plugin-next', 'eslint-config-next'], upTo: '16.4.0' },
  // Seven moderate Next.js advisories, fixed in 16.4.5 (cache disclosure and poisoning, SVG
  // check bypass, HttpOnly cookie disclosure on Edge routes, response injection between clients).
  ...['GHSA-mfr8-8qww-v76h', 'GHSA-vc7v-qv4w-wrv8', 'GHSA-7qx7-33qx-rqx2', 'GHSA-f3mh-rxg3-f5g2', 'GHSA-pc58-hwjq-p385', 'GHSA-rhh4-g77r-r9qj', 'GHSA-vvgp-ww4w-46vf']
    .map(ghsa => ({ ghsa, packages: ['next', '@next/env', '@next/eslint-plugin-next', 'eslint-config-next'], upTo: '16.4.4' })),
  { ghsa: 'GHSA-67mh-4wv8-2f99', packages: ['esbuild'], upTo: '0.24.2' },
];
// Advisories fixed by a minimum version: every locked version must be at least `from`.
// zod <4.6.6 (app and lint toolchain); @azure/msal-node >=5.0.0-beta.0 <7.1.0 through @azure/identity;
// fast-xml-parser <=5.11.2 through @azure/storage-blob -> @azure/core-xml.
const minimums = [
  { ghsa: 'GHSA-mrhx-c7xc-m3w5', name: 'zod', from: '4.6.6' },
  { ghsa: 'GHSA-xcx6-jx8p-x3h5', name: '@azure/msal-node', from: '7.1.0' },
  { ghsa: 'GHSA-474x-hrwr-fgx4', name: 'fast-xml-parser', from: '5.12.0' },
];
// Advisories with an affected range [from, below): minimatch >=7.0.0 <11.0.1 through
// @typescript-eslint/typescript-estree (lint toolchain). minimatch 3.x of the ESLint plugins is outside.
const minimatchAdvisory = { ghsa: 'GHSA-g3hv-75wg-m249', name: 'minimatch', from: '7.0.0', below: '11.0.1' };
// The pin must stay out of the Next 16.x range of the Next.js advisories (>=16.0.0 <=16.4.4).
const nextFrom = '16.0.0';
const nextUpTo = '16.4.4';

const semver = /^(\d+)\.(\d+)\.(\d+)$/;
function compare(left, right) {
  const a = semver.exec(left);
  const b = semver.exec(right);
  assert.ok(a && b, `compare needs X.Y.Z versions, got ${left} and ${right}`);
  for (let i = 1; i <= 3; i++) {
    const delta = Number(a[i]) - Number(b[i]);
    if (delta) return Math.sign(delta);
  }
  return 0;
}

// `@next/env@16.4.2(peer@1.0.0)` -> { name: '@next/env', version: '16.4.2' }
function parseKey(key) {
  const bare = key.split('(')[0];
  const at = bare.lastIndexOf('@');
  assert.ok(at > 0, `unexpected lockfile key ${key}`);
  return { name: bare.slice(0, at), version: bare.slice(at + 1) };
}

function lockedVersions(lockfile, name) {
  const versions = Object.keys(lockfile.packages ?? {}).map(parseKey).filter(entry => entry.name === name).map(entry => entry.version);
  return [...new Set(versions)];
}

// Every snapshot or importer that depends on `name`, as "name@version" or "importer <path>".
function dependents(lockfile, name) {
  const found = new Set();
  const lists = entry => [entry?.dependencies, entry?.optionalDependencies, entry?.devDependencies];
  for (const [key, entry] of Object.entries(lockfile.snapshots ?? {})) {
    if (lists(entry).some(list => list && name in list)) {
      const { name: dependent, version } = parseKey(key);
      found.add(`${dependent}@${version}`);
    }
  }
  for (const [importer, entry] of Object.entries(lockfile.importers ?? {})) {
    if (lists(entry).some(list => list && name in list)) found.add(`importer ${importer}`);
  }
  return [...found].sort();
}

// The locked versions of `name` below `from`; a version that is no plain X.Y.Z (a prerelease) counts as below.
function belowMinimum(lockfile, name, from) {
  return lockedVersions(lockfile, name).filter(version => !semver.test(version) || compare(version, from) < 0);
}

const names = list => [...new Set(list.map(entry => (entry.startsWith('importer ') ? entry : parseKey(entry).name)))];

test('the X.Y.Z compare orders numerically', () => {
  assert.equal(compare('16.4.0', '16.4.0'), 0);
  assert.equal(compare('16.4.2', '16.4.10'), -1);
  assert.equal(compare('16.10.0', '16.4.9'), 1);
  assert.equal(compare('0.25.0', '0.24.2'), 1);
  assert.equal(compare('0.18.20', '0.24.2'), -1);
});

const nextVulnerable = version => compare(version, nextFrom) >= 0 && compare(version, nextUpTo) <= 0;

test('next and eslint-config-next are pinned to the same exact version outside the vulnerable range', () => {
  const next = manifest.dependencies.next;
  assert.equal(next, manifest.devDependencies['eslint-config-next'], 'next and eslint-config-next move together');
  assert.match(next, semver, 'next is an exact X.Y.Z pin');
  assert.ok(!nextVulnerable(next), `next ${next} is in the vulnerable range >=${nextFrom} <=${nextUpTo}`);
  // The range edges: 16.0.0 to 16.4.4 are vulnerable, 15.x and 16.4.5 onwards are not.
  for (const version of ['16.0.0', '16.4.0', '16.4.2', '16.4.4']) assert.ok(nextVulnerable(version), `${version} counts as vulnerable`);
  for (const version of ['15.5.29', '16.4.5', '16.4.6', '16.5.0']) assert.ok(!nextVulnerable(version), `${version} does not count as vulnerable`);
  assert.equal(manifest.devDependencies['drizzle-kit'], '0.31.10', 'drizzle-kit stays; 0.31.11 still pulls @esbuild-kit');
});

// `next`, `eslint-config-next` and every `@next/*` package (also the eight `@next/swc-*`
// builds) as { name: [versions] }, from the lockfile packages.
function nextFamily(lockfile) {
  const family = {};
  for (const { name, version } of Object.keys(lockfile.packages ?? {}).map(parseKey)) {
    if (name !== 'next' && name !== 'eslint-config-next' && !name.startsWith('@next/')) continue;
    family[name] = [...new Set([...(family[name] ?? []), version])];
  }
  return family;
}

test('every next, eslint-config-next and @next/* package is locked only at the pinned next version', () => {
  const pinned = manifest.dependencies.next;
  const family = nextFamily(lock);
  for (const name of ['next', 'eslint-config-next', '@next/env', '@next/eslint-plugin-next']) assert.ok(family[name], `${name} is in the lockfile`);
  assert.equal(Object.keys(family).filter(name => name.startsWith('@next/swc-')).length, 8, 'the eight @next/swc-* platform builds are in the lockfile');
  for (const [name, versions] of Object.entries(family)) assert.deepEqual(versions, [pinned], `${name} is locked only at ${pinned}`);
  // A stale copy next to the new one is reported.
  const mixed = nextFamily({ packages: { 'next@16.4.6': {}, '@next/swc-linux-x64-gnu@16.4.2': {}, '@next/swc-linux-x64-gnu@16.4.6': {}, 'nextra@4.0.0': {} } });
  assert.deepEqual(mixed, { next: ['16.4.6'], '@next/swc-linux-x64-gnu': ['16.4.2', '16.4.6'] });
});

test('the install policy keeps the seven-day release age without exceptions', () => {
  assert.equal(workspace.minimumReleaseAge, 10080);
  assert.equal(workspace.minimumReleaseAgeIgnoreMissingTime, false);
  assert.equal(workspace.trustLockfile, false);
  assert.equal(workspace.minimumReleaseAgeExclude, undefined, 'no release-age exception');
});

test('no locked package version is affected by a fixed advisory', () => {
  for (const { ghsa, packages, upTo } of fixed) {
    for (const name of packages) {
      const versions = lockedVersions(lock, name);
      assert.ok(versions.length > 0, `${name} is in the lockfile`);
      for (const version of versions) {
        assert.ok(compare(version, upTo) > 0, `${name}@${version} is affected by ${ghsa} (vulnerable up to ${upTo})`);
      }
    }
  }
  assert.deepEqual(lockedVersions(lock, 'drizzle-kit'), ['0.31.10']);
});

test('the esbuild overrides lift every old esbuild, including the one under @esbuild-kit', () => {
  assert.equal(workspace.overrides['esbuild@<0.25.0'], '0.28.1');
  assert.equal(workspace.overrides['esbuild@>=0.25.0'], '0.28.1');
  const coreUtils = Object.entries(lock.snapshots).filter(([key]) => parseKey(key).name === '@esbuild-kit/core-utils');
  assert.ok(coreUtils.length > 0, '@esbuild-kit/core-utils is in the lockfile (drizzle-kit)');
  for (const [key, entry] of coreUtils) assert.equal(entry.dependencies.esbuild, '0.28.1', `${key} resolves esbuild 0.28.1`);
});

test('the audit exception holds exactly the braces advisory and no other audit setting', () => {
  assert.deepEqual(workspace.audit?.ignore, [bracesAdvisory]);
  assert.deepEqual(Object.keys(workspace.audit), ['ignore'], 'no audit.level, audit.ignorePrune or other audit key');
  for (const key of ['auditLevel', 'auditConfig']) assert.equal(workspace[key], undefined, `${key} is not set`);
  assert.equal(manifest.scripts['check:audit'], 'pnpm audit --audit-level high');
  assert.equal(manifest.pnpm?.auditConfig, undefined, 'no deprecated auditConfig in package.json');
});

// The braces rule as a function, so the stale-exception branch is tested too.
function bracesExceptionProblem(lockfile, ignore) {
  const vulnerable = lockedVersions(lockfile, 'braces').filter(version => compare(version, '3.0.3') <= 0);
  const listed = (ignore ?? []).includes(bracesAdvisory);
  if (vulnerable.length && !listed) return `braces ${vulnerable.join(', ')} is locked, but audit.ignore misses ${bracesAdvisory}`;
  if (!vulnerable.length && listed) return `no braces <=3.0.3 is locked any more: remove ${bracesAdvisory} from audit.ignore in pnpm-workspace.yaml`;
  return undefined;
}

test('the braces exception matches the lockfile and goes stale once braces is fixed', () => {
  assert.equal(bracesExceptionProblem(lock, workspace.audit?.ignore), undefined);
  const withoutBraces = { packages: { 'braces@3.0.4': {} } };
  assert.match(bracesExceptionProblem(withoutBraces, [bracesAdvisory]), /remove GHSA-vfj7-8cjw-p6xm/);
  assert.equal(bracesExceptionProblem(withoutBraces, []), undefined);
  assert.match(bracesExceptionProblem({ packages: { 'braces@3.0.3': {} } }, []), /misses GHSA-vfj7-8cjw-p6xm/);
});

test('braces is reached only through the lint toolchain: micromatch <- fast-glob <- @next/eslint-plugin-next', () => {
  const chain = [['braces', 'micromatch'], ['micromatch', 'fast-glob'], ['fast-glob', '@next/eslint-plugin-next']];
  for (const [name, expected] of chain) {
    if (!lockedVersions(lock, name).length) continue;
    const found = dependents(lock, name);
    const unexpected = found.filter(entry => names([entry])[0] !== expected);
    assert.deepEqual(unexpected, [], `${name} has new dependents ${unexpected.join(', ')}; only ${expected} may depend on it while ${bracesAdvisory} is ignored`);
    assert.deepEqual(names(found), [expected], `${name} is reached through ${expected}`);
  }
  // The helper reports a new dependent by name.
  const extra = { snapshots: { 'micromatch@4.0.8': { dependencies: { braces: '3.0.3' } }, 'chokidar@3.6.0': { dependencies: { braces: '3.0.3' } } } };
  assert.deepEqual(dependents(extra, 'braces'), ['chokidar@3.6.0', 'micromatch@4.0.8']);
});

test('zod, @azure/msal-node and fast-xml-parser are locked at or above their fixed versions only', () => {
  for (const { ghsa, name, from } of minimums) {
    assert.ok(lockedVersions(lock, name).length > 0, `${name} is in the lockfile`);
    assert.deepEqual(belowMinimum(lock, name, from), [], `${name} below ${from} is affected by ${ghsa}`);
  }
  // Negative cases on synthetic lockfiles: an old copy anywhere in the tree is reported.
  const zods = { packages: { 'zod@4.6.7': {}, 'zod@3.25.76': {}, 'zod@4.6.5': {} } };
  assert.deepEqual(belowMinimum(zods, 'zod', '4.6.6'), ['3.25.76', '4.6.5']);
  const msal = { packages: { '@azure/msal-node@7.2.1': {}, '@azure/msal-node@6.0.1': {}, '@azure/msal-node@7.0.9': {}, '@azure/msal-node@7.1.0-beta.1': {} } };
  assert.deepEqual(belowMinimum(msal, '@azure/msal-node', '7.1.0'), ['6.0.1', '7.0.9', '7.1.0-beta.1']);
  assert.deepEqual(belowMinimum({ packages: { 'zod@4.6.6': {}, '@azure/msal-node@7.1.0': {} } }, 'zod', '4.6.6'), []);
  const xml = { packages: { 'fast-xml-parser@5.11.2': {}, 'fast-xml-parser@5.12.0': {}, 'fast-xml-parser@5.12.1': {} } };
  assert.deepEqual(belowMinimum(xml, 'fast-xml-parser', '5.12.0'), ['5.11.2']);
});

test('@azure/core-xml resolves a patched fast-xml-parser 5.12.x', () => {
  const coreXml = Object.entries(lock.snapshots).filter(([key]) => parseKey(key).name === '@azure/core-xml');
  assert.ok(coreXml.length > 0, '@azure/core-xml is in the lockfile (@azure/storage-blob)');
  for (const [key, entry] of coreXml) {
    const version = entry.dependencies['fast-xml-parser'];
    assert.match(version, /^5\.12\.\d+$/, `${key} resolves fast-xml-parser 5.12.x, got ${version}`);
  }
});

// The locked versions of `name` in the affected range [from, below); a prerelease counts as affected.
function inAffectedRange(lockfile, { name, from, below }) {
  return lockedVersions(lockfile, name).filter(version => !semver.test(version) || (compare(version, from) >= 0 && compare(version, below) < 0));
}

test('no locked minimatch is in the affected range of GHSA-g3hv-75wg-m249', () => {
  assert.ok(lockedVersions(lock, 'minimatch').length > 0, 'minimatch is in the lockfile');
  assert.deepEqual(inAffectedRange(lock, minimatchAdvisory), [], `minimatch >=${minimatchAdvisory.from} <${minimatchAdvisory.below} is affected by ${minimatchAdvisory.ghsa}`);
  // Negative cases on a synthetic lockfile: the range edges.
  const synthetic = { packages: Object.fromEntries(['3.1.5', '7.0.0', '10.2.5', '11.0.0', '11.0.1', '11.0.8'].map(version => [`minimatch@${version}`, {}])) };
  assert.deepEqual(inAffectedRange(synthetic, minimatchAdvisory), ['7.0.0', '10.2.5', '11.0.0']);
});

test('@typescript-eslint/typescript-estree resolves a patched minimatch', () => {
  const estree = Object.entries(lock.snapshots).filter(([key]) => parseKey(key).name === '@typescript-eslint/typescript-estree');
  assert.ok(estree.length > 0, '@typescript-eslint/typescript-estree is in the lockfile (eslint-config-next)');
  for (const [key, entry] of estree) {
    const version = entry.dependencies.minimatch;
    assert.ok(semver.test(version ?? '') && compare(version, minimatchAdvisory.below) >= 0, `${key} resolves minimatch ${version}, needs at least ${minimatchAdvisory.below}`);
  }
});

// `typescript-eslint` and every `@typescript-eslint/*` package with its locked versions.
function typescriptEslintVersions(lockfile) {
  const versions = new Set();
  const found = [];
  for (const { name, version } of Object.keys(lockfile.packages ?? {}).map(parseKey)) {
    if (name !== 'typescript-eslint' && !name.startsWith('@typescript-eslint/')) continue;
    versions.add(version);
    found.push(name);
  }
  return { names: [...new Set(found)].sort(), versions: [...versions].sort() };
}

test('typescript-eslint and all @typescript-eslint/* packages are locked at one shared version', () => {
  const { names: packages, versions } = typescriptEslintVersions(lock);
  for (const name of ['typescript-eslint', '@typescript-eslint/parser', '@typescript-eslint/typescript-estree']) assert.ok(packages.includes(name), `${name} is in the lockfile`);
  assert.equal(versions.length, 1, `one shared version, got ${versions.join(', ')}`);
  // A stale copy next to the new one is reported.
  const mixed = typescriptEslintVersions({ packages: { 'typescript-eslint@8.73.0': {}, '@typescript-eslint/typescript-estree@8.59.3': {}, 'eslint@9.39.4': {} } });
  assert.deepEqual(mixed.versions, ['8.59.3', '8.73.0']);
});

test('the manifest asks for patched zod and @azure/identity ranges, and the installed copies are patched', () => {
  const caret = (range, label) => {
    const match = /^\^(\d+\.\d+\.\d+)$/.exec(range ?? '');
    assert.ok(match, `${label} is a caret range, got ${range}`);
    return match[1];
  };
  const zod = caret(manifest.dependencies.zod, 'zod');
  assert.equal(semver.exec(zod)[1], '4', 'zod stays on major 4');
  assert.ok(compare(zod, '4.6.6') >= 0, `zod ${zod} is at least 4.6.6`);
  const identity = caret(manifest.dependencies['@azure/identity'], '@azure/identity');
  assert.equal(semver.exec(identity)[1], '4', '@azure/identity stays on major 4');
  // 4.14.0 still requires @azure/msal-node ^6; 4.14.1 is the first release on ^7.1.0.
  assert.ok(compare(identity, '4.14.1') >= 0, `@azure/identity ${identity} is at least 4.14.1`);
  assert.ok(compare(require('zod/package.json').version, '4.6.6') >= 0, 'the installed zod is patched');
  const msal = createRequire(require.resolve('@azure/identity'))('@azure/msal-node/package.json').version;
  assert.ok(compare(msal, '7.1.0') >= 0, `the @azure/msal-node that @azure/identity loads (${msal}) is at least 7.1.0`);
});
