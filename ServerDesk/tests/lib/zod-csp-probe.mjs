// The browser hook instrumentation-client.ts switches zod to jitless before any
// schema is built, so building and parsing an object schema never calls
// Function, which the enforced CSP (no 'unsafe-eval') reports as a violation.
// Without the hook, zod probes with Function("") when it builds an object
// schema; a child process shows that, so this test notices a zod change that
// makes the setting useless.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { serverDeskRoot } from '../support/paths.mjs';

const hook = path.join(serverDeskRoot, 'instrumentation-client.ts');
const zodUrl = pathToFileURL(path.join(serverDeskRoot, 'node_modules', 'zod', 'index.js')).href;
// Counts calls of the global Function, then builds and parses an object schema.
const probe = setup => `
const calls = [];
const original = globalThis.Function;
globalThis.Function = new Proxy(original, { apply(target, self, args) { calls.push(args); return Reflect.apply(target, self, args); }, construct(target, args) { calls.push(args); return Reflect.construct(target, args); } });
${setup}
const { z } = await import(${JSON.stringify(zodUrl)});
const schema = z.object({ name: z.string(), count: z.number().int() });
const parsed = schema.parse({ name: 'a', count: 1 });
if (parsed.name !== 'a' || schema.safeParse({ name: 1 }).success) throw new Error('the schema did not parse');
console.log(JSON.stringify(calls.length));
`;
const run = setup => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe(setup)], { cwd: serverDeskRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
};

assert.ok(run('') > 0, 'without the hook zod probes with Function when it builds an object schema');
assert.equal(run(`await import(${JSON.stringify(pathToFileURL(hook).href)});`), 0, 'after the hook zod never calls Function');
const source = readFileSync(hook, 'utf8');
assert.match(source, /^import \{z\} from 'zod';$/m, 'the hook uses the zod of the app');
assert.match(source, /^z\.config\(\{jitless: true\}\);$/m, 'the hook switches zod to jitless');
console.log('PASS zod CSP probe: the browser hook makes zod build and parse object schemas without Function, and without it zod probes.');
