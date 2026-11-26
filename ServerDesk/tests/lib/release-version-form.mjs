// The version form of agent and plugin releases (runtime/release-version.mjs): X.Y.Z without leading zeros or a
// dev build X.Y.Z-dev.<sha7>, isDevVersion, the base X.Y.Z, the rank order (a release above a dev build of its base,
// two dev builds of the same base with equal rank), the dev version of a commit, the build version of the build
// scripts, the heartbeat pattern with an optional dev suffix, and the guard that no other JS/TS file of the
// portal holds a second copy of the dev pattern.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  baseVersion, baseVersionPattern, buildVersion, compareReleaseRank, devVersion, isBaseVersion, isDevVersion, isReleaseVersion, releaseVersionPattern, withOptionalDevSuffix,
} from '../../runtime/release-version.mjs';
import { serverDeskRoot } from '../support/paths.mjs';

let checks = 0;
const check = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };

// ---- The pattern: valid and refused forms ----
for (const value of ['0.0.0', '4.21.5', '10.200.3000', '4.21.5-dev.abc1234', '4.21.5-dev.0000000', '1.0.0-dev.ffffff0']) {
  check([isReleaseVersion(value), releaseVersionPattern.test(value)], [true, true], `${value} is a release version`);
}
for (const value of ['4.21.5-dev.ABC1234', '4.21.5-dev.abc123', '4.21.5-rc.1', '4.21.5-dev.abc1234.1', '04.1.0', '4.01.0', '4.1.00', '4.21', '4.21.5.0',
  '4.21.5-dev.abc12345', '4.21.5-dev.ghijklm', '4.21.5-dev-abc1234', ' 4.21.5', '4.21.5\n', '', null, undefined, 4215]) {
  check([isReleaseVersion(value), isDevVersion(value), baseVersion(value)], [false, false, null], `${JSON.stringify(value)} is refused`);
}
check(['4.21.5', '4.21.5-dev.abc1234', '04.1.0'].map(isBaseVersion), [true, false, false], 'a base version is X.Y.Z without a suffix (also a minimum agent version)');
check(['4.21.5', '4.21.5-dev.abc1234'].map(value => baseVersionPattern.test(value)), [true, false], 'baseVersionPattern');
check(['4.21.5', '4.21.5-dev.abc1234'].map(isDevVersion), [false, true], 'isDevVersion');
check(['4.21.5', '4.21.5-dev.abc1234', '0.0.1-dev.1234567'].map(baseVersion), ['4.21.5', '4.21.5', '0.0.1'], 'the base of a version');

// ---- The rank order ----
check(compareReleaseRank('4.21.5', '4.21.5-dev.abc1234'), 1, 'a release ranks above a dev build of its base');
check(compareReleaseRank('4.21.5-dev.abc1234', '4.21.4'), 1, 'a dev build ranks above the release before its base');
check(compareReleaseRank('4.21.5-dev.abc1234', '4.21.5'), -1, 'and below the release of its base');
check(compareReleaseRank('4.21.5-dev.aaaaaaa', '4.21.5-dev.bbbbbbb'), 0, 'two dev builds of the same base have equal rank');
check(compareReleaseRank('4.21.5', '4.21.5'), 0, 'equal strings');
check(compareReleaseRank('4.10.0', '4.9.9'), 1, 'numeric, not text order');
check(compareReleaseRank('4.21.6-dev.abc1234', '4.21.5'), 1, 'the base counts first');
check([compareReleaseRank('broken', '4.21.5'), compareReleaseRank('4.21.5', '4.21.5-rc.1'), compareReleaseRank('04.1.0', '4.1.0')], [null, null, null], 'null when one side is no version');
const sorted = ['4.21.4', '4.21.5-dev.abc1234', '4.21.5', '4.22.0-dev.0000000', '4.9.0'].sort((a, b) => compareReleaseRank(b, a));
check(sorted, ['4.22.0-dev.0000000', '4.21.5', '4.21.5-dev.abc1234', '4.21.4', '4.9.0'], 'the order 4.21.5 > 4.21.5-dev.abc1234 > 4.21.4');

// ---- The dev version of a commit and the build version ----
const sha = 'ABC1234def567890abcdef1234567890abcdef12';
check(devVersion('4.21.5', sha), '4.21.5-dev.abc1234', 'the first 7 characters, lowercase');
assert.throws(() => devVersion('4.21.5', 'abc1234'), /40 hex/); checks++;
assert.throws(() => devVersion('4.21.5', undefined), /40 hex/); checks++;
assert.throws(() => devVersion('4.21', sha), /must be X\.Y\.Z/); checks++;
check(buildVersion('4.21.5', undefined), { version: '4.21.5', devSuffix: '' }, 'no requested version: the project version');
check(buildVersion('4.21.5', ''), { version: '4.21.5', devSuffix: '' }, 'an empty variable: the project version');
check(buildVersion('4.21.5', '4.21.5'), { version: '4.21.5', devSuffix: '' }, 'the project version');
check(buildVersion('4.21.5', '4.21.5-dev.abc1234'), { version: '4.21.5-dev.abc1234', devSuffix: '-dev.abc1234' }, 'the project version with a dev suffix');
for (const requested of ['4.21.6', '4.21.4-dev.abc1234', '4.21.5-dev.ABC1234', '4.21.5-rc.1', '4.21.5-dev.abc1234.1']) {
  assert.throws(() => buildVersion('4.21.5', requested), { message: `The build version "${requested}" must be 4.21.5 or 4.21.5-dev.<sha7>.` }, requested); checks++;
}

// ---- Other bases with the optional suffix (the heartbeat) ----
const heartbeat = withOptionalDevSuffix('[34]\\.\\d+\\.\\d+');
check(['4.21.5', '3.1.0', '4.21.5-dev.abc1234', '5.0.0', '4.21.5-dev.abc123', '4.21.5-rc.1'].map(value => heartbeat.test(value)), [true, true, true, false, false, false], 'the heartbeat pattern');

// ---- One place: no second copy of the dev pattern in the JS/TS of the portal ----
const roots = ['app', 'lib', 'ui', 'runtime', 'scripts', 'db'].map(folder => path.join(serverDeskRoot, folder));
const walk = directory => { let entries; try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return []; } return entries.flatMap(entry => entry.isDirectory() ? (entry.name === 'node_modules' ? [] : walk(path.join(directory, entry.name))) : /\.(?:m?js|tsx?)$/.test(entry.name) ? [path.join(directory, entry.name)] : []); };
const copies = roots.flatMap(walk).filter(file => /-dev\\?\.?\[0-9a-f\]\{7\}|dev\\\\\.\[0-9a-f\]/.test(readFileSync(file, 'utf8')))
  .map(file => path.relative(serverDeskRoot, file).split(path.sep).join('/'));
check(copies, ['runtime/release-version.mjs'], 'the dev pattern lives only in runtime/release-version.mjs');

console.log(`PASS release version (${checks} checks): X.Y.Z and X.Y.Z-dev.<sha7>, the refused forms, the base, the rank order, the dev version of a commit, the build version, the heartbeat pattern and one place for the dev pattern.`);
