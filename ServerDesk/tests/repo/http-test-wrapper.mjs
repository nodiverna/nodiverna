// pnpm test:http (scripts/http-test.mjs) without a real build: the arguments,
// the step order, the throwaway key outside the copy and the cleanup of the
// copy and the key, also after a failing step, and the copy mark of the pin
// step (SERVERDESK_TEST_PUBLISHER_COPY). The working tree stays as it is.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { defaultSteps, runHttpTest, usage } from '../../scripts/http-test.mjs';
import { serverDeskRoot } from '../support/paths.mjs';

const realRoot = serverDeskRoot;
function collector() { const sink = { text: '', write(chunk) { sink.text += chunk; return true; } }; return sink; }

async function scratch(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'serverdesk-http-wrapper-'));
  try {
    const root = path.join(directory, 'ServerDesk'), tmpdir = path.join(directory, 'tmp');
    await mkdir(path.join(root, 'tests', 'integration'), { recursive: true });
    await mkdir(path.join(root, 'tests', 'lib'), { recursive: true });
    await mkdir(tmpdir);
    await writeFile(path.join(root, 'tests', 'integration', 'http-selfhost.mjs'), '// fixture\n');
    // Files that exist outside tests/integration/, so only their folder refuses them.
    await writeFile(path.join(root, 'tests', 'http-selfhost.mjs'), '// fixture\n');
    await writeFile(path.join(root, 'tests', 'lib', 'x.mjs'), '// fixture\n');
    return await run({ root, tmpdir });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

// Steps that record the context and create the copy and the key as the real ones do.
function recording(fail) {
  const calls = [];
  const step = name => async context => {
    calls.push({ name, context });
    if (name === 'copy') { await mkdir(context.cwd, { recursive: true }); await writeFile(path.join(context.cwd, 'copied'), 'x'); }
    if (name === 'pin') await writeFile(context.key, 'test key');
    if (name === fail) throw new Error(`${name} broke`);
  };
  return { calls, steps: Object.fromEntries(['copy', 'pin', 'build', 'test'].map(name => [name, step(name)])) };
}

test('the arguments name exactly one existing test file in tests/integration/', () => scratch(async ({ root, tmpdir }) => {
  for (const args of [[], ['tests/missing.mjs'], ['tests/integration/missing.mjs'], ['tests/integration/http-selfhost.mjs', 'extra'], ['../tests/integration/http-selfhost.mjs'], ['../tests/integration/x.mjs'], ['scripts/http-test.mjs'], ['tests/http-selfhost.js'], ['tests/http-selfhost.mjs'], ['tests/lib/x.mjs'], ['tests/integration/../http-selfhost.mjs']]) {
    const stderr = collector(), { calls, steps } = recording();
    assert.equal(await runHttpTest({ root, args, stderr, stdout: collector(), steps, tmpdir }), 2, args.join(' '));
    assert.equal(stderr.text, `${usage}\n`);
    assert.deepEqual(calls, [], 'nothing runs');
  }
  assert.equal(usage, 'Usage: node scripts/http-test.mjs tests/integration/<name>.mjs');
}));

test('the steps run in order with the key outside the copy, and the copy and the key are removed afterwards', () => scratch(async ({ root, tmpdir }) => {
  const stdout = collector(), { calls, steps } = recording();
  assert.equal(await runHttpTest({ root, args: ['tests/integration/http-selfhost.mjs'], stdout, stderr: collector(), steps, tmpdir }), 0);
  assert.deepEqual(calls.map(call => call.name), ['copy', 'pin', 'build', 'test']);
  const { context } = calls[0];
  assert.equal(context.root, path.resolve(root));
  assert.equal(context.file, 'tests/integration/http-selfhost.mjs');
  assert.ok(path.relative(context.cwd, context.key).startsWith('..'), 'the key is outside the copy');
  assert.equal(path.dirname(context.key), path.dirname(context.cwd), 'the key sits next to the copy');
  assert.equal(existsSync(context.cwd), false, 'the copy is removed');
  assert.equal(existsSync(context.key), false, 'the key is removed');
  assert.deepEqual(await readdir(tmpdir), [], 'nothing is left in the temporary directory');
  assert.deepEqual(await readdir(root), ['tests'], 'the working tree is unchanged');
  assert.match(stdout.text, /passed on a build that trusts a throwaway test publisher/);
}));

test('a failing step stops the run with exit code 1, and the copy and the key are still removed', () => scratch(async ({ root, tmpdir }) => {
  for (const fail of ['copy', 'pin', 'build', 'test']) {
    const stderr = collector(), { calls, steps } = recording(fail);
    assert.equal(await runHttpTest({ root, args: ['tests/integration/http-selfhost.mjs'], stdout: collector(), stderr, steps, tmpdir }), 1, fail);
    assert.equal(calls.at(-1).name, fail, 'no step after the failure');
    const { context } = calls[0];
    assert.equal(existsSync(context.cwd), false, `${fail}: the copy is removed`);
    assert.equal(existsSync(context.key), false, `${fail}: the key is removed`);
    assert.deepEqual(await readdir(tmpdir), [], `${fail}: nothing is left`);
    assert.match(stderr.text, new RegExp(`${fail} broke`));
  }
}));

test('the real steps pin with the test publisher, build like pnpm build and run the test with the key', () => {
  assert.deepEqual(Object.keys(defaultSteps), ['copy', 'pin', 'build', 'test']);
  // The original checkout has its HTTP test and the default steps use the scripts of the copy.
  assert.ok(existsSync(path.join(realRoot, 'tests', 'integration', 'http-selfhost.mjs')));
  assert.ok(existsSync(path.join(realRoot, 'scripts', 'test-publisher.mjs')));
});

test('the real pin step marks the copy with SERVERDESK_TEST_PUBLISHER_COPY equal to the copy', () => scratch(async ({ root }) => {
  // A stand-in scripts/test-publisher.mjs in the copy records its arguments and the mark.
  const cwd = root, key = path.join(path.dirname(root), 'test-publisher-private.pem'), out = path.join(path.dirname(root), 'pin.json');
  await mkdir(path.join(cwd, 'scripts'), { recursive: true });
  await writeFile(path.join(cwd, 'scripts', 'test-publisher.mjs'), `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(out)}, JSON.stringify({ args: process.argv.slice(2), mark: process.env.SERVERDESK_TEST_PUBLISHER_COPY, cwd: process.cwd() }));\n`);
  await defaultSteps.pin({ cwd, key });
  const recorded = JSON.parse(await readFile(out, 'utf8'));
  assert.deepEqual(recorded, { args: ['pin', '--key', key], mark: cwd, cwd: recorded.cwd });
  assert.equal(await realpath(recorded.cwd), await realpath(cwd), 'pin runs in the copy');
}));
