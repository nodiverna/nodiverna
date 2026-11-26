import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { validateReleaseChangelog } from '../../scripts/release-changelog.mjs';
import { serverDeskRoot } from '../support/paths.mjs';

// Every agent release note must pass the signer's own validation, so an
// over-long note fails the merge gate instead of the release signing.
const changelogDir = new URL('../../agent/v3/changelogs/', import.meta.url);
const files = readdirSync(changelogDir).filter(name => name.endsWith('.json')).sort();
const root = serverDeskRoot;
const historyScript = path.join(root, 'scripts', 'agent-changelog-history.mjs');
const outOfDate = 'lib/agent-changelog-history.json is out of date. Run node scripts/agent-changelog-history.mjs.';
const versionParts = version => version.split('.').map(Number);
const newestFirst = (a, b) => { const [x, y] = [versionParts(a.version), versionParts(b.version)]; for (let index = 0; index < 3; index++) if (x[index] !== y[index]) return y[index] - x[index]; return 0; };

test('the agent changelog directory has changelog files', () => {
  assert.ok(files.length > 0, 'no *.json files in agent/v3/changelogs/');
});

for (const file of files) {
  test(`agent/v3/changelogs/${file} passes the release notes validation`, () => {
    const version = file.slice(0, -'.json'.length);
    const value = JSON.parse(readFileSync(new URL(file, changelogDir), 'utf8'));
    assert.doesNotThrow(() => validateReleaseChangelog(value, version), `agent/v3/changelogs/${file} fails the release notes validation`);
  });
}

test('lib/agent-changelog-history.json is current: every changelog, validated and newest first', () => {
  const check = spawnSync(process.execPath, [historyScript, '--check'], { cwd: root, encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
  const expected = files.map(file => {
    const version = file.slice(0, -'.json'.length);
    return { version, ...validateReleaseChangelog(JSON.parse(readFileSync(new URL(file, changelogDir), 'utf8')), version) };
  }).sort(newestFirst);
  const history = JSON.parse(readFileSync(path.join(root, 'lib', 'agent-changelog-history.json'), 'utf8'));
  assert.deepEqual(history, expected);
  assert.equal(history.length, files.length);
  assert.ok(history.findIndex(entry => entry.version === '4.10.0') < history.findIndex(entry => entry.version === '4.9.0'), 'semantic order');
});

test('the history script writes the file and --check fails for a new changelog without writing', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'serverdesk-changelog-history-'));
  try {
    cpSync(path.join(root, 'agent', 'v3', 'changelogs'), path.join(directory, 'agent', 'v3', 'changelogs'), { recursive: true });
    cpSync(path.join(root, 'lib', 'agent-changelog-history.json'), path.join(directory, 'lib', 'agent-changelog-history.json'));
    const run = (...args) => spawnSync(process.execPath, [historyScript, ...args], { cwd: directory, encoding: 'utf8' });
    assert.equal(run('--check').status, 0);
    writeFileSync(path.join(directory, 'agent', 'v3', 'changelogs', '4.99.0.json'), JSON.stringify({ version: '4.99.0', features: [' New in 4.99.0 '], fixes: [] }));
    const before = readFileSync(path.join(directory, 'lib', 'agent-changelog-history.json'), 'utf8');
    const stale = run('--check');
    assert.equal(stale.status, 1);
    assert.equal(stale.stderr.trim(), outOfDate);
    assert.equal(readFileSync(path.join(directory, 'lib', 'agent-changelog-history.json'), 'utf8'), before, '--check writes nothing');
    const written = run();
    assert.equal(written.status, 0, written.stderr);
    assert.deepEqual(JSON.parse(readFileSync(path.join(directory, 'lib', 'agent-changelog-history.json'), 'utf8'))[0], { version: '4.99.0', features: ['New in 4.99.0'], fixes: [] });
    assert.equal(run('--check').status, 0);
    // An invalid changelog stops the script with its file name.
    writeFileSync(path.join(directory, 'agent', 'v3', 'changelogs', '4.98.0.json'), JSON.stringify({ version: '4.98.0', features: [], fixes: [] }));
    const invalid = run('--check');
    assert.equal(invalid.status, 1);
    assert.equal(invalid.stderr.trim(), 'agent/v3/changelogs/4.98.0.json is not a valid changelog: A new Agent release requires at least one feature or bugfix.');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
