// `node scripts/selfhost.mjs secrets`: the secret generator of the README quick
// start. It runs without any environment, prints only the four env lines (after
// optional # comments), gives new values each run, and its values pass
// validateEnvironment; with an argument it fails and prints nothing on stdout.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createPrivateKey } from 'node:crypto';
import path from 'node:path';
import { serverDeskRoot } from '../support/paths.mjs';
import { validateEnvironment } from '../../runtime/env.mjs';
import { usage } from '../../scripts/selfhost.mjs';

const script = path.join(serverDeskRoot, 'scripts', 'selfhost.mjs');
// Only what Node needs to start: no DATABASE_URL, SITE_ORIGIN or secret.
const bareEnvironment = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']
  .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
for (const key of ['DATABASE_URL', 'DATABASE_PASSWORD', 'SITE_ORIGIN', 'SESSION_SECRET', 'PASSWORD_PEPPER', 'AGENT_JOB_SIGNING_KEY']) {
  assert.equal(bareEnvironment[key], undefined, `${key} is not set for the child`);
}
const run = (...args) => spawnSync(process.execPath, [script, 'secrets', ...args], { cwd: serverDeskRoot, env: bareEnvironment, encoding: 'utf8' });

const parse = output => {
  const lines = output.split('\n');
  assert.equal(lines.at(-1), '', 'the output ends with a line break');
  lines.pop();
  const values = lines.filter(line => !line.startsWith('#'));
  assert.ok(lines.slice(0, lines.length - values.length).every(line => line.startsWith('#')), 'comment lines come only before the values');
  assert.deepEqual(values.map(line => line.slice(0, line.indexOf('='))), ['SESSION_SECRET', 'PASSWORD_PEPPER', 'DATABASE_PASSWORD', 'AGENT_JOB_SIGNING_KEY'], 'exactly the four keys, in order');
  return Object.fromEntries(values.map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
};

const first = run();
assert.equal(first.status, 0, first.stderr);
assert.equal(first.stderr, '', 'nothing on stderr');
const secrets = parse(first.stdout);
for (const key of ['SESSION_SECRET', 'PASSWORD_PEPPER']) {
  assert.match(secrets[key], /^[A-Za-z0-9_-]{64}$/, `${key} is 48 bytes as base64url`);
  assert.equal(Buffer.from(secrets[key], 'base64url').length, 48);
}
assert.notEqual(secrets.SESSION_SECRET, secrets.PASSWORD_PEPPER, 'the two secrets differ');
assert.match(secrets.DATABASE_PASSWORD, /^[0-9a-f]{48}$/, 'DATABASE_PASSWORD is 24 bytes as hex');
assert.match(secrets.AGENT_JOB_SIGNING_KEY, /^[A-Za-z0-9+/]+=*$/, 'the key is one line of base64');
const key = createPrivateKey({ key: Buffer.from(secrets.AGENT_JOB_SIGNING_KEY, 'base64'), format: 'der', type: 'pkcs8' });
assert.equal(key.asymmetricKeyType, 'ec');
assert.equal(key.asymmetricKeyDetails.namedCurve, 'prime256v1');
assert.doesNotThrow(() => validateEnvironment({
  SESSION_SECRET: secrets.SESSION_SECRET, PASSWORD_PEPPER: secrets.PASSWORD_PEPPER,
  SITE_ORIGIN: 'https://localhost:8443', DATABASE_URL: 'postgres://serverdesk@db:5432/serverdesk',
}));

const second = parse(run().stdout);
for (const name of Object.keys(secrets)) assert.notEqual(second[name], secrets[name], `${name} is new at each run`);

const extra = run('--x');
assert.notEqual(extra.status, 0, 'an argument fails');
assert.equal(extra.stdout, '', 'nothing on stdout');
assert.equal(extra.stderr.trim(), 'ServerDesk: secrets accepts no further arguments.');

assert.ok(usage.split('\n').some(line => line.trim() === 'node scripts/selfhost.mjs secrets'), 'usage lists the secrets command without --env-file');

console.log('selfhost secrets tests passed');
