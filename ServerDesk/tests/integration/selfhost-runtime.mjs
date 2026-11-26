// Startup checks of the runtime (runtime/env.mjs): secrets, HTTPS, the database URL, readiness and the
// connection settings (pnpm test:selfhost).
import assert from 'node:assert/strict';
import test from 'node:test';
import { validateEnvironment } from '../../runtime/env.mjs';

test('startup requires secrets, HTTPS outside localhost, a PostgreSQL URL without password and shared objects for replication', () => {
  const config = { SESSION_SECRET: 'a'.repeat(48), PASSWORD_PEPPER: 'b'.repeat(48), SITE_ORIGIN: 'https://portal.example.test', DATABASE_URL: 'postgres://serverdesk@db:5432/serverdesk' };
  validateEnvironment(config);
  for (const override of [
    { PASSWORD_PEPPER: 'short' }, { SESSION_SECRET: '' }, { SITE_ORIGIN: 'http://192.168.1.1:8443' },
    { SITE_ORIGIN: 'https://portal.example.test/path' },
    { WEB_CONCURRENCY: '2', OBJECT_STORAGE_DRIVER: 'filesystem' },
    { SESSION_SECRET_PREVIOUS: 'short' }, { SESSION_SECRET_PREVIOUS: `${'c'.repeat(48)},short` },
  ]) assert.throws(() => validateEnvironment({ ...config, ...override }));
  // DATABASE_URL: required, postgres:// or postgresql://, user, host, port and database, no password, TLS for a remote host.
  for (const [url, message] of [
    [undefined, /DATABASE_URL is required/], ['', /DATABASE_URL is required/],
    ['postgres://serverdesk:secret@db:5432/serverdesk', /must not contain a password/],
    ['mysql://serverdesk@db:3306/serverdesk', /must start with postgres/], ['https://db.example', /must start with postgres/],
    ['postgres://db:5432/serverdesk', /user, host, port and database/], ['postgres://serverdesk@db/serverdesk', /user, host, port and database/], ['postgres://serverdesk@db:5432', /user, host, port and database/],
    ['postgres://serverdesk@pg.example.com:5432/serverdesk', /requires TLS/], ['postgres://serverdesk@pg.example.com:5432/serverdesk?sslmode=disable', /requires TLS/], ['postgres://serverdesk@pg.example.com:5432/serverdesk?sslmode=prefer', /requires TLS/],
  ]) assert.throws(() => validateEnvironment({ ...config, DATABASE_URL: url }), { message }, String(url));
  for (const url of ['postgres://serverdesk@db:5432/serverdesk', 'postgresql://serverdesk@localhost:5432/serverdesk', 'postgres://serverdesk@127.0.0.1:5432/serverdesk', 'postgres://serverdesk@[::1]:5432/serverdesk',
    'postgres://serverdesk@pg.example.com:5432/serverdesk?sslmode=require', 'postgres://serverdesk@pg.example.com:5432/serverdesk?sslmode=verify-ca', 'postgres://serverdesk@pg.example.com:5432/serverdesk?sslmode=verify-full']) validateEnvironment({ ...config, DATABASE_URL: url });
  // Old secrets for a SESSION_SECRET change are optional, each needs 32 bytes.
  for (const previous of [undefined, '', 'c'.repeat(48), ` ${'c'.repeat(48)} , `]) validateEnvironment({ ...config, SESSION_SECRET_PREVIOUS: previous });
  assert.throws(() => validateEnvironment({ ...config, SESSION_SECRET_PREVIOUS: 'short' }), { message: 'SESSION_SECRET_PREVIOUS entries need at least 32 random bytes each.' });
  // Several web replicas need only shared object storage; the database is shared anyway.
  validateEnvironment({ ...config, WEB_CONCURRENCY: '2', OBJECT_STORAGE_DRIVER: 'azure' });
  validateEnvironment({ ...config, SITE_ORIGIN: 'http://localhost:3000' });
  // A leftover legacy activation switch in an old .env is ignored.
  validateEnvironment({ ...config, [['ALLOW', 'LEGACY', 'ACTIVATION'].join('_')]: '1' });
});

test('readiness answers 503 without a database, when it does not answer, or when a shipped migration is missing', async () => {
  await import('../support/register.mjs');
  const { isReady } = await import('../../lib/server/readiness.ts');
  const journal = { entries: [{ tag: '0000_baseline' }, { tag: '0001_next' }] };
  const bucket = { head: async () => null };
  const stub = names => ({ query: async () => names.map(name => ({ name })) });
  assert.equal(await isReady({ database: null, bucket, journal }), false, 'no DATABASE_URL');
  const started = Date.now();
  assert.equal(await isReady({ database: { query: () => new Promise(() => {}) }, bucket, journal, timeoutMs: 300 }), false, 'no answer');
  assert.ok(Date.now() - started < 5000, 'the check answers within 5 s');
  assert.equal(await isReady({ database: { query: async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); } }, bucket, journal }), false, 'connection refused');
  assert.equal(await isReady({ database: stub(['0000_baseline.sql']), bucket, journal }), false, 'a shipped migration is missing');
  assert.equal(await isReady({ database: stub(['0000_baseline.sql', '0001_next.sql']), bucket, journal }), true, 'all shipped migrations');
  assert.equal(await isReady({ database: stub(['0000_baseline.sql', '0001_next.sql', '0002_newer.sql']), bucket, journal }), true, 'an extra newer journal row is allowed');
  assert.equal(await isReady({ database: stub(['0000_baseline.sql', '0001_next.sql']), bucket: { head: async () => { throw new Error('storage down'); } }, journal }), false, 'storage fails');
});

test('the connection settings refuse an unknown sslmode instead of falling back to plaintext', async () => {
  const { connectionOptions } = await import('../../runtime/database.mjs');
  // The CLI (selfhost.mjs) does not run validateEnvironment, so the data layer itself fails closed.
  for (const mode of ['verify_full', 'requre', '', 'VERIFY-FULL']) {
    assert.throws(() => connectionOptions(`postgres://serverdesk@pg.example.com:5432/serverdesk?sslmode=${mode}`), { message: /unknown sslmode/ }, mode);
  }
  assert.equal(connectionOptions('postgres://serverdesk@db:5432/serverdesk').ssl, false);
  assert.equal(connectionOptions('postgres://serverdesk@pg.example.com:5432/serverdesk').ssl, 'require');
  assert.equal(connectionOptions('postgres://serverdesk@pg.example.com:5432/serverdesk?sslmode=verify-full').ssl, 'verify-full');
  assert.equal(connectionOptions('postgres://serverdesk@db:5432/serverdesk?sslmode=allow').ssl, 'prefer');
  assert.equal(connectionOptions('postgres://serverdesk@db:5432/serverdesk?sslmode=disable').ssl, false);
});
