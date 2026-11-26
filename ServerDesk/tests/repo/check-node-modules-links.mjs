// Relative pnpm directory symlinks on Windows are found and turned into junctions.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { findRelativeDirectoryLinks, fixRelativeDirectoryLinks, runCheck } from '../../scripts/check-node-modules-links.mjs';

const relativeLinkMarker = 'relative directory symlinks';

// Relative directory symlinks need Administrator or Developer Mode on Windows.
function canCreateDirectorySymlinks() {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'serverdesk-link-probe-'));
  try {
    fs.mkdirSync(path.join(directory, 'target'));
    fs.symlinkSync('target', path.join(directory, 'link'), 'dir');
    return true;
  } catch (error) {
    if (error.code === 'EPERM') return false;
    throw error;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
const symlinks = canCreateDirectorySymlinks();
const needsSymlinks = symlinks ? {} : { skip: 'relative directory symlinks need Administrator or Developer Mode' };
if (!symlinks) console.log('SKIP relative symlink cases: creating directory symlinks fails with EPERM on this host');

function collector() {
  const sink = { text: '', write(chunk) { sink.text += chunk; return true; } };
  return sink;
}

function check(root, platform, args = [], fileSystem) {
  const stdout = collector();
  const stderr = collector();
  const code = runCheck({ platform, root, args, stdout, stderr, fileSystem });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

/** A fake pnpm tree: two store packages, one with a real subdirectory. */
function withTree(callback) {
  const parent = path.resolve(tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'serverdesk-node-modules-'));
  const modules = path.join(root, 'node_modules');
  const write = (relative, contents) => {
    const file = path.join(modules, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  };
  const at = relative => path.join(modules, relative);
  /** A relative directory symlink, as pnpm creates it as Administrator. */
  const relativeLink = (relative, targetRelative) => {
    const link = at(relative);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(path.relative(path.dirname(link), at(targetRelative)), link, 'dir');
    return link;
  };
  /** A junction on Windows; an absolute symlink elsewhere. */
  const junction = (relative, targetRelative) => {
    const link = at(relative);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(at(targetRelative), link, 'junction');
    return link;
  };
  try {
    write('.pnpm/a@1.0.0/node_modules/a/index.js', 'module.exports = "a";');
    write('.pnpm/a@1.0.0/node_modules/a/lib/inner.js', 'module.exports = "inner";');
    write('.pnpm/@s+b@1.0.0/node_modules/@s/b/index.js', 'module.exports = "b";');
    write('.pnpm/lock.yaml', 'lockfileVersion: 9.0\n');
    write('.modules.yaml', 'layoutVersion: 5\n');
    callback({ root, modules, at, write, relativeLink, junction });
  } finally {
    // Delete only the direct child of the temp root created by this fixture.
    assert.equal(path.dirname(root), parent);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function addPnpmLinks(tree) {
  return [
    tree.relativeLink('a', '.pnpm/a@1.0.0/node_modules/a'),
    tree.relativeLink('@s/b', '.pnpm/@s+b@1.0.0/node_modules/@s/b'),
    tree.relativeLink('.pnpm/a@1.0.0/node_modules/dep', '.pnpm/@s+b@1.0.0/node_modules/@s/b'),
  ].sort();
}

const listing = directory => fs.readdirSync(directory, { recursive: true }).map(String).sort();

test('finds relative directory symlinks on every pnpm link level, sorted', needsSymlinks, () => withTree(tree => {
  const expected = addPnpmLinks(tree);
  tree.relativeLink('.pnpm/node_modules/a', '.pnpm/a@1.0.0/node_modules/a');
  tree.relativeLink('.pnpm/node_modules/@s/b', '.pnpm/@s+b@1.0.0/node_modules/@s/b');
  tree.relativeLink('.pnpm/@s+b@1.0.0/node_modules/@s/c', '.pnpm/a@1.0.0/node_modules/a');
  expected.push(tree.at('.pnpm/node_modules/a'), tree.at('.pnpm/node_modules/@s/b'), tree.at('.pnpm/@s+b@1.0.0/node_modules/@s/c'));
  assert.deepEqual(findRelativeDirectoryLinks(tree.root), expected.sort());
}));

test('detects exactly the three pnpm links of the test plan', needsSymlinks, () => withTree(tree => {
  const expected = addPnpmLinks(tree);
  assert.deepEqual(findRelativeDirectoryLinks(tree.root), expected);
  assert.deepEqual(expected.map(link => path.relative(tree.root, link).replaceAll('\\', '/')).sort(), [
    'node_modules/.pnpm/a@1.0.0/node_modules/dep', 'node_modules/@s/b', 'node_modules/a',
  ]);
}));

test('ignores junctions, file links, broken links and links inside package contents', needsSymlinks, () => withTree(tree => {
  tree.junction('c', '.pnpm/a@1.0.0/node_modules/a');
  fs.symlinkSync(path.join('.pnpm', 'a@1.0.0', 'node_modules', 'a', 'index.js'), tree.at('file-link'), 'file');
  fs.symlinkSync(path.join('.pnpm', 'missing@1.0.0', 'node_modules', 'missing'), tree.at('broken'), 'dir');
  tree.relativeLink('.pnpm/a@1.0.0/node_modules/a/nested', '.pnpm/@s+b@1.0.0/node_modules/@s/b');
  tree.relativeLink('.pnpm/a@1.0.0/node_modules/a/lib/deeper', '.pnpm/@s+b@1.0.0/node_modules/@s/b');
  assert.deepEqual(findRelativeDirectoryLinks(tree.root), []);
}));

test('never follows a link into its target while scanning', needsSymlinks, () => withTree(tree => {
  // A junction to a directory that looks like a scope or store level holds a
  // relative link; reaching it would mean the scan followed the junction.
  tree.relativeLink('.pnpm/a@1.0.0/node_modules/a/lib/@x/hidden', '.pnpm/@s+b@1.0.0/node_modules/@s/b');
  tree.junction('@x', '.pnpm/a@1.0.0/node_modules/a/lib/@x');
  assert.deepEqual(findRelativeDirectoryLinks(tree.root), []);
}));

test('does nothing outside Windows, with and without --fix', needsSymlinks, () => withTree(tree => {
  const links = addPnpmLinks(tree);
  const before = links.map(link => fs.readlinkSync(link));
  for (const args of [[], ['--fix']]) {
    for (const platform of ['linux', 'darwin']) {
      assert.deepEqual(check(tree.root, platform, args), { code: 0, stdout: '', stderr: '' });
    }
  }
  assert.deepEqual(links.map(link => fs.readlinkSync(link)), before);
}));

test('on Windows reports the links with count, examples and both ways out, and changes nothing', needsSymlinks, () => withTree(tree => {
  const links = addPnpmLinks(tree);
  const before = links.map(link => fs.readlinkSync(link));
  const result = check(tree.root, 'win32');
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, [
    'node_modules contains 3 relative directory symlinks instead of junctions. This happens when pnpm runs as administrator on Windows, and it makes the standalone build fail with EPERM.',
    '  - node_modules/.pnpm/a@1.0.0/node_modules/dep',
    '  - node_modules/@s/b',
    '  - node_modules/a',
    'Repair it with "node scripts/check-node-modules-links.mjs --fix", or install again without administrator rights (delete node_modules, then run pnpm install).',
    '',
  ].join('\n'));
  assert.match(result.stderr, new RegExp(relativeLinkMarker));
  assert.deepEqual(links.map(link => fs.readlinkSync(link)), before);
}));

test('lists at most five example paths and marks the rest', needsSymlinks, () => withTree(tree => {
  for (const name of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']) tree.relativeLink(name, '.pnpm/a@1.0.0/node_modules/a');
  const result = check(tree.root, 'win32');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /contains 7 relative directory symlinks/);
  assert.equal(result.stderr.match(/^ {2}- node_modules\/p\d$/gm).length, 5);
  assert.match(result.stderr, /^ {2}- …$/m);
  assert.doesNotMatch(result.stderr, /node_modules\/p6/);
}));

test('--fix turns every link into a junction to the same directory without touching package contents', needsSymlinks, () => withTree(tree => {
  const links = addPnpmLinks(tree);
  const targets = links.map(link => path.resolve(path.dirname(link), fs.readlinkSync(link)));
  const packages = [tree.at('.pnpm/a@1.0.0/node_modules/a'), tree.at('.pnpm/@s+b@1.0.0/node_modules/@s/b')];
  const before = packages.map(listing);

  const result = check(tree.root, 'win32', ['--fix']);
  assert.deepEqual(result, { code: 0, stdout: 'Replaced 3 directory symlinks in node_modules with junctions.\n', stderr: '' });
  assert.deepEqual(findRelativeDirectoryLinks(tree.root), []);
  links.forEach((link, index) => {
    const target = fs.readlinkSync(link);
    assert.ok(path.isAbsolute(target), `${link} -> ${target}`);
    assert.equal(fs.realpathSync(link), fs.realpathSync(targets[index]));
  });
  assert.equal(fs.readFileSync(tree.at('a/index.js'), 'utf8'), 'module.exports = "a";');
  assert.equal(fs.readFileSync(tree.at('@s/b/index.js'), 'utf8'), 'module.exports = "b";');
  assert.equal(fs.readFileSync(tree.at('.pnpm/a@1.0.0/node_modules/dep/index.js'), 'utf8'), 'module.exports = "b";');
  assert.deepEqual(packages.map(listing), before);
  assert.deepEqual(fs.readdirSync(tree.at('@s')), ['b']);
  assert.deepEqual(check(tree.root, 'win32', []), { code: 0, stdout: '', stderr: '' });

  assert.deepEqual(check(tree.root, 'win32', ['--fix']), { code: 0, stdout: '', stderr: '' });
}));

test('fixRelativeDirectoryLinks returns the fixed paths', needsSymlinks, () => withTree(tree => {
  const links = addPnpmLinks(tree);
  assert.deepEqual(fixRelativeDirectoryLinks(tree.root), links);
  assert.deepEqual(fixRelativeDirectoryLinks(tree.root), []);
}));

test('a failed replacement stops with path and cause and keeps the original link', needsSymlinks, () => withTree(tree => {
  const links = addPnpmLinks(tree);
  const before = links.map(link => fs.readlinkSync(link));
  const failing = {
    ...fs,
    symlinkSync() {
      throw Object.assign(new Error('EPERM: operation not permitted, symlink'), { code: 'EPERM' });
    },
  };
  const result = check(tree.root, 'win32', ['--fix'], failing);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'Could not convert node_modules/.pnpm/a@1.0.0/node_modules/dep into a junction: EPERM: operation not permitted, symlink. Delete node_modules and run pnpm install without administrator rights.\n');
  assert.deepEqual(links.map(link => fs.readlinkSync(link)), before);
  assert.deepEqual(fs.readdirSync(tree.at('.pnpm/a@1.0.0/node_modules')).sort(), ['a', 'dep']);
}));

test('a clean tree with junctions and a root without node_modules pass silently on Windows', () => {
  withTree(tree => {
    tree.junction('a', '.pnpm/a@1.0.0/node_modules/a');
    tree.junction('@s/b', '.pnpm/@s+b@1.0.0/node_modules/@s/b');
    tree.junction('.pnpm/node_modules/a', '.pnpm/a@1.0.0/node_modules/a');
    assert.deepEqual(findRelativeDirectoryLinks(tree.root), []);
    assert.deepEqual(check(tree.root, 'win32'), { code: 0, stdout: '', stderr: '' });
    assert.deepEqual(check(tree.root, 'win32', ['--fix']), { code: 0, stdout: '', stderr: '' });
  });
  const empty = fs.mkdtempSync(path.join(tmpdir(), 'serverdesk-no-modules-'));
  try {
    assert.deepEqual(findRelativeDirectoryLinks(empty), []);
    assert.deepEqual(check(empty, 'win32'), { code: 0, stdout: '', stderr: '' });
    assert.deepEqual(check(empty, 'win32', ['--fix']), { code: 0, stdout: '', stderr: '' });
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('unknown arguments print the usage line and return 2', () => {
  const usage = 'Usage: node scripts/check-node-modules-links.mjs [--fix]\n';
  for (const args of [['--bogus'], ['--fix', '--bogus'], ['fix']]) {
    assert.deepEqual(check(tmpdir(), 'win32', args), { code: 2, stdout: '', stderr: usage });
  }
});

test('build and test:http run the check first', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.scripts.build, 'node scripts/check-node-modules-links.mjs && next build --webpack');
  assert.equal(manifest.scripts['test:http'], 'node scripts/check-node-modules-links.mjs && node scripts/http-test.mjs tests/integration/http-selfhost.mjs');
});
