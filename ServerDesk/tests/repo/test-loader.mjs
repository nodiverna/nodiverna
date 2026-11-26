// The shared TypeScript loader (tests/support/register.mjs), the relative
// date-bomb clock (tests/support/clock.mjs) and how scripts/test.mjs finds every
// test file below tests/. The loader has one alias, "@/", and no switch that
// hides a folder.
import {loaderInfo, mock, register, tsconfigPaths} from '../support/register.mjs';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {futureTestNow} from '../support/clock.mjs';
import {serverDeskRoot} from '../support/paths.mjs';

const root = serverDeskRoot;
const registerUrl = pathToFileURL(path.join(root, 'tests', 'support', 'register.mjs')).href;
const fixedClockUrl = pathToFileURL(path.join(root, 'tests', 'support', 'fixed-clock.mjs')).href;
function child(code, {env = {}, preload = []} = {}) {
  const childEnv = {...process.env};
  delete childEnv.SERVERDESK_TEST_NOW;
  Object.assign(childEnv, env);
  const result = spawnSync(process.execPath, [...preload.flatMap(url => ['--import', url]), '--input-type=module', '-e', code], {cwd: root, encoding: 'utf8', env: childEnv, timeout: 60_000});
  return {...result, output: `${result.stdout}${result.stderr}${result.error ?? ''}`};
}
function childJson(code, options) {
  const result = child(code, options);
  assert.equal(result.status, 0, result.output);
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}
const ends = (value, suffix, message) => assert.ok(value.endsWith(suffix), `${message}: ${value} does not end with ${suffix}`);

// Registered once, as first import or as preload; a clear stop on old Node.js.
assert.equal(register(), false, 'a second register() call adds no hooks');
const second = await import('../support/register.mjs?second-evaluation');
assert.equal(second.register(), false, 'a second evaluation of the module adds no hooks');
assert.equal(loaderInfo().registrations, 1);
assert.equal(second.loaderInfo().registrations, 1);
let preloaded = childJson(`const {value} = await import('@/tests/support/fixtures/target'); console.log(JSON.stringify({value}));`, {preload: [registerUrl]});
assert.equal(preloaded.value, 'real value', 'the preload transpiles TS and resolves @/');
preloaded = childJson(`import './tests/support/register.mjs'; import {loaderInfo} from './tests/support/register.mjs?again'; console.log(JSON.stringify(loaderInfo()));`, {preload: [registerUrl]});
assert.equal(preloaded.registrations, 1, 'preload plus import registers the hooks once');
const oldNode = child(`await import('./tests/support/register.mjs');`, {preload: [`data:text/javascript,import m from 'node:module';m.registerHooks=undefined;`]});
assert.notEqual(oldNode.status, 0);
assert.match(oldNode.output, /tests\/support\/register\.mjs needs Node\.js 22\.15 or newer \(module\.registerHooks\)\./);

// TS and TSX become ES modules, type-only imports without `type` vanish,
// typescript loads on the first TS module, node_modules stays untouched.
const {describeShape} = await import('../support/fixtures/type-only-import.ts');
assert.deepEqual(describeShape({name: 'Quadrat', corners: 4}), {label: 'Quadrat (4)'});
const lazy = childJson(`import './tests/support/register.mjs';
import {createRequire} from 'node:module';
const cache = createRequire(import.meta.url).cache;
const loaded = () => Object.keys(cache).some(file => /[\\\\/]typescript[\\\\/]lib[\\\\/]typescript\\.js$/.test(file));
const before = loaded();
await import('./tests/support/fixtures/target.ts');
console.log(JSON.stringify({before, after: loaded()}));`);
assert.deepEqual(lazy, {before: false, after: true}, 'typescript is loaded with the first TS module, not before');
await assert.rejects(import(pathToFileURL(path.join(root, 'node_modules', 'zod', 'src', 'index.ts')).href), error => error.code === 'ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING', 'TS files under node_modules are left to Node.js');

// Aliases come from compilerOptions.paths in tsconfig.json.
const tsconfig = JSON.parse(readFileSync(path.join(root, 'tsconfig.json'), 'utf8'));
assert.deepEqual(loaderInfo().aliasPatterns, Object.keys(tsconfig.compilerOptions.paths), 'the loader uses exactly the tsconfig.json patterns');
assert.deepEqual(tsconfigPaths().paths, tsconfig.compilerOptions.paths);
assert.equal(await import('@/lib/server/agent/telemetry'), await import('../../lib/server/agent/telemetry.ts'), '@/lib/server/agent/telemetry is the same module as ../lib/server/agent/telemetry.ts');
ends(import.meta.resolve('@/lib/server/agent/telemetry'), '/lib/server/agent/telemetry.ts', '@/ maps to the ServerDesk folder');
assert.deepEqual(Object.keys(tsconfig.compilerOptions.paths), ['@/*'], 'the one alias is "@/"');
assert.deepEqual(Object.keys(loaderInfo()).sort(), ['aliasPatterns', 'registrations', 'root'], 'loaderInfo reports no folder switch');
assert.equal(typeof (await import('@/ui/devices/device/device-removal')).deviceRemovalConfirmation, 'function', 'a .tsx with @/ imports loads');

// Extension probing order.
ends(import.meta.resolve('../../lib/server/devices/hardware-inventory'), '/lib/server/devices/hardware-inventory.ts', 'a relative import finds .ts');
ends(import.meta.resolve('@/ui/devices/device/device-removal'), '/ui/devices/device/device-removal.tsx', 'an alias target finds .tsx');
ends(import.meta.resolve('../../runtime/env'), '/runtime/env.mjs', 'a relative import finds .mjs');
assert.equal((await import('../support/fixtures/probe-order')).picked, 'ts', '.ts comes before .tsx');
assert.equal((await import('@/tests/support/fixtures/folder')).folder, 'folder/index.ts', 'a folder import finds /index.ts');
await assert.rejects(import('../support/fixtures/missing'), error => error.code === 'ERR_MODULE_NOT_FOUND');

// CSS is an empty module, cloudflare:workers is runtime/env.mjs.
assert.deepEqual(Object.keys(await import('../support/fixtures/empty.css')), []);
assert.deepEqual(Object.keys(await import('../../ui/styles/classic-console.css')), []);
assert.equal((await import('../support/fixtures/with-css.ts')).withCss, true, 'a TS module with a CSS import loads');
ends(import.meta.resolve('cloudflare:workers'), '/runtime/env.mjs', 'cloudflare:workers follows next.config.ts');
assert.ok(Array.isArray((await import('../../drizzle/meta/_journal.json')).default.entries), 'a JSON import without attributes gets the parsed file');


// A mock replaces the file for every spelling of the import.
mock('tests/support/fixtures/target.ts', {value: 'mocked value'});
const {sibling} = await import('../support/fixtures/via-sibling.ts');
const {parent} = await import('../support/fixtures/nested/via-parent.ts');
const {alias} = await import('../support/fixtures/via-alias.ts');
assert.equal(sibling.value, 'mocked value', "'./target' gets the mock");
assert.equal(parent, 'mocked value', "'../target' gets the mock");
assert.equal(alias, 'mocked value', "'@/tests/support/fixtures/target' gets the mock");
assert.equal(sibling.other, undefined, 'a real export the mock lacks links as undefined');
assert.deepEqual(sibling.target, {value: 'mocked value'}, 'without a default key the default export is the mock object');
const mocked = await import('../support/fixtures/target.ts');
assert.deepEqual(Object.keys(mocked).sort(), ['default', 'other', 'value']);
mock('next/navigation', {default: 'navigation default', useRouter: () => 'router'});
const navigation = await import('next/navigation');
assert.equal(navigation.default, 'navigation default', 'exports.default is the default export');
assert.equal(navigation.useRouter(), 'router', 'a package is mocked by its bare specifier');

// mock() refuses missing files and targets that are already imported.
assert.throws(() => mock('lib/servr.ts', {}), {message: 'mock(): lib/servr.ts does not exist'});
assert.throws(() => mock('lib/step-up.ts', {}), {message: 'mock(): lib/step-up.ts was already imported; call mock() before the first import'});
assert.throws(() => mock('tests/support/fixtures/target.ts', {}), {message: 'mock(): tests/support/fixtures/target.ts was already imported; call mock() before the first import'});
assert.throws(() => mock('lib\\server\\context.ts', {}), TypeError, 'targets use forward slashes');

// The date bomb is today plus four years at UTC midnight.
assert.equal(futureTestNow(Date.UTC(2026, 9, 21, 15, 30)), '2030-10-21T00:00:00.000Z');
assert.equal(futureTestNow(Date.UTC(2028, 1, 29)), '2032-02-29T00:00:00.000Z');
assert.equal(futureTestNow(Date.UTC(2096, 1, 29)), '2100-03-01T00:00:00.000Z', '29 February into a non-leap year rolls over to 1 March');
const dayBefore = futureTestNow().slice(0, 10);
const clock = child('console.log(new Date().toISOString());', {preload: [fixedClockUrl]});
assert.equal(clock.status, 0, clock.output);
assert.ok([dayBefore, futureTestNow().slice(0, 10)].includes(clock.stdout.trim().slice(0, 10)), `fixed-clock.mjs defaults to futureTestNow(): ${clock.stdout}`);
for (const file of ['scripts/test.mjs', 'tests/support/fixed-clock.mjs']) assert.doesNotMatch(readFileSync(path.join(root, file), 'utf8'), /2030-01-01/, `${file} has no fixed test date`);

// Importing scripts/test.mjs starts nothing, and it finds every test file itself:
// files is every .mjs file below tests/ outside support/, fixtures/ and
// integration/, as its path relative to tests/ without .mjs.
const exitCode = process.exitCode;
const {files, fixedClockFiles, excludedFolders, ...otherExports} = await import('../../scripts/test.mjs');
assert.equal(process.exitCode, exitCode, 'importing scripts/test.mjs runs no tests');
assert.deepEqual(excludedFolders, ['support', 'fixtures', 'integration']);
assert.deepEqual(Object.keys(otherExports), [], 'scripts/test.mjs exports no other list (no helperFiles, no otherSuiteFiles)');
assert.ok(files.includes('repo/test-loader'));
assert.ok(files.length > 300, `files holds the test suite (${files.length})`);
assert.deepEqual(files, [...files].sort(), 'files is sorted');
assert.ok(files.every(name => /^[\w-]+(?:\/[\w-]+)*$/.test(name) && !name.endsWith('.mjs')), 'files holds paths relative to tests/ with / and without .mjs');
const runnerSource = readFileSync(path.join(root, 'scripts', 'test.mjs'), 'utf8');
assert.doesNotMatch(runnerSource, /'(?:[\w-]+\/)*(?:test-loader|lint-scope|fixed-clock|mfa-fixture|source-database|http-selfhost|selfhost-runtime)'/, 'scripts/test.mjs has no hand-written list of test names');
// The folder is read relative to the script, not to the working directory.
const elsewhere = spawnSync(process.execPath, ['--input-type=module', '-e', `const {files}=await import(${JSON.stringify(pathToFileURL(path.join(root, 'scripts', 'test.mjs')).href)});console.log(JSON.stringify(files));`], {cwd: path.join(root, 'tests', 'support'), encoding: 'utf8'});
assert.equal(elsewhere.status, 0, elsewhere.stderr);
assert.deepEqual(JSON.parse(elsewhere.stdout.trim()), files, 'another working directory finds the same test files');
// The runner over a tree of its own: a file in a new folder runs without an edit,
// the files of the excluded folders do not, also in their subfolders.
const tree = mkdtempSync(path.join(os.tmpdir(), 'serverdesk-test-runner-'));
try {
  const put = (file, text = '') => { mkdirSync(path.dirname(path.join(tree, file)), {recursive: true}); writeFileSync(path.join(tree, file), text); };
  put('scripts/test.mjs', runnerSource);
  put('tests/support/clock.mjs', readFileSync(path.join(root, 'tests', 'support', 'clock.mjs'), 'utf8'));
  for (const file of ['tests/support/fixed-clock.mjs', 'tests/support/deep/helper.mjs', 'tests/fixtures/data.mjs', 'tests/integration/selfhost-x.mjs', 'tests/newfolder/new-test.mjs', 'tests/ui/newarea/view.mjs', 'tests/root-test.mjs', 'tests/api/notes.txt']) put(file);
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `const {files}=await import(${JSON.stringify(pathToFileURL(path.join(tree, 'scripts', 'test.mjs')).href)});console.log(JSON.stringify(files));`], {cwd: os.tmpdir(), encoding: 'utf8'});
  assert.equal(probe.status, 0, probe.stderr);
  assert.deepEqual(JSON.parse(probe.stdout.trim()), ['newfolder/new-test', 'root-test', 'ui/newarea/view'], 'a new file in any other folder runs; support/, fixtures/ and integration/ do not');
} finally { rmSync(tree, {recursive: true, force: true}); }
const escape = text => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
const globPattern = glob => new RegExp(`^${glob.split('**/').map(part => part.split('*').map(escape).join('[^/]*')).join('(?:[^/]+/)*')}$`);
const scripts = Object.entries(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).scripts);
const scriptPatterns = scripts.flatMap(([script, command]) => [...command.matchAll(/tests\/([^\s'"]+)\.mjs/g)]
  .map(([, glob]) => ({script, pattern: globPattern(glob)})));
assert.ok(scriptPatterns.some(({script, pattern}) => script === 'test:selfhost' && pattern.test('integration/selfhost-runtime')));
assert.ok(scriptPatterns.some(({script, pattern}) => script === 'test:selfhost' && pattern.test('lib/selfhost-releases')), 'test:selfhost finds selfhost-* files in every folder');
assert.ok(scriptPatterns.some(({script, pattern}) => script === 'test:http' && pattern.test('integration/http-selfhost')));
const testFiles = readdirSync(path.join(root, 'tests'), {recursive: true, withFileTypes: true})
  .filter(entry => entry.isFile() && entry.name.endsWith('.mjs'))
  .map(entry => path.relative(path.join(root, 'tests'), path.join(entry.parentPath, entry.name)).split(path.sep).join('/').slice(0, -4));
assert.ok(testFiles.length > 350, `the recursive read finds the test files (${testFiles.length})`);
const inFolder = folder => testFiles.filter(name => name.startsWith(`${folder}/`));
const helperFiles = inFolder('support'), integrationFiles = inFolder('integration');
assert.deepEqual([...files, ...excludedFolders.flatMap(inFolder)].sort(), [...testFiles].sort(), 'files and the .mjs files of support/, fixtures/ and integration/ together are exactly the .mjs files below tests/, so a new file in any other folder runs in pnpm test without an edit');
for (const helper of ['fixed-clock', 'mfa-fixture', 'source-database']) assert.ok(helperFiles.includes(`support/${helper}`), `tests/support/ holds ${helper}.mjs`);
assert.deepEqual(files.filter(name => excludedFolders.includes(name.split('/')[0])), [], 'no entry of files is below support/, fixtures/ or integration/');
assert.equal(new Set(files).size, files.length, 'files has no duplicates');
assert.ok(integrationFiles.length >= 13, `tests/integration/ holds the other suites (${integrationFiles.length})`);
for (const name of integrationFiles) assert.ok(scriptPatterns.some(({script, pattern}) => ['test:selfhost', 'test:http'].includes(script) && pattern.test(name)), `${name} runs through pnpm test:selfhost or test:http`);
for (const name of testFiles.filter(name => /(?:^|\/)selfhost-[^/]*$/.test(name) && !name.startsWith('integration/'))) assert.ok(files.includes(name), `${name} also runs in pnpm test`);
for (const name of fixedClockFiles) {
  assert.ok(files.includes(name), `the fixed-clock file ${name} is also a regular run`);
  assert.ok(existsSync(path.join(root, 'tests', `${name}.mjs`)), `the fixed-clock entry ${name} is tests/${name}.mjs`);
}
assert.equal(fixedClockFiles.length, 8, 'eight files run a second time with the fixed clock');

console.log('PASS test loader: tsconfig aliases, extension probing, CSS and cloudflare:workers, path-based mocks, one-time registration, relative date bomb and the test registry.');
