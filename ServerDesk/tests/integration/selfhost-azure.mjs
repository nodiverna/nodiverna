import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import test from 'node:test';
import {sql} from '../../runtime/database.mjs';
import {createStorage} from '../../runtime/storage.mjs';

import {sourceDatabase} from '../support/source-database.mjs';
import {testDatabase} from '../support/postgres.mjs';
import {readFileSync} from 'node:fs';
// The readiness rule of the route (lib/server/readiness.ts) with this database and storage.
async function ready(database, bucket) {
  await import('../support/register.mjs');
  const {isReady} = await import('../../lib/server/readiness.ts');
  const ok = await isReady({database, bucket});
  return Response.json({status: ok ? 'ok' : 'unavailable'}, {status: ok ? 200 : 503});
}

async function fixture(errorCode, operation) {
  const requests = [], payload = Buffer.from([0, 128, 255]);
  const server = createServer((request, response) => {
    requests.push({method: request.method, path: request.url});
    const headers = {'x-ms-request-id': '00000000-0000-4000-8000-000000000000'};
    if (errorCode) {
      response.writeHead(errorCode === 'AuthorizationFailure' ? 403 : 404, {
        ...headers, 'x-ms-error-code': errorCode, 'Content-Type': 'application/xml',
      });
      response.end(request.method === 'HEAD' ? undefined : `<Error><Code>${errorCode}</Code><Message>Isolated Azure fixture.</Message></Error>`);
    } else {
      response.writeHead(200, {
        ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': String(payload.length),
        ETag: '"fixture-etag"', 'Last-Modified': new Date('2026-10-10T00:00:00Z').toUTCString(),
        'x-ms-meta-serverdeskmeta': Buffer.from(JSON.stringify({sha256: 'fixture'})).toString('base64url'),
      });
      response.end(request.method === 'HEAD' ? undefined : payload);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const database = await sourceDatabase();
  try {
    // A disposable dummy credential drives the actual Azure SDK against only
    // this loopback endpoint. No live Azure account or secrets are consulted.
    const connection = `DefaultEndpointsProtocol=http;AccountName=fixture;AccountKey=${Buffer.alloc(32).toString('base64')};BlobEndpoint=http://127.0.0.1:${server.address().port}`;
    const bucket = createStorage({OBJECT_STORAGE_DRIVER: 'azure', AZURE_STORAGE_CONNECTION_STRING: connection, AZURE_STORAGE_CONTAINER: 'serverdesk'});
    await operation({bucket, database, requests, payload});
    assert.ok(requests.length > 0, 'the real Azure SDK reached the isolated endpoint');
  } finally {
    database.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

test('Azure BlobNotFound means an absent object and permits a healthy readiness sentinel', async () => {
  await fixture('BlobNotFound', async ({bucket, database}) => {
    assert.equal(await bucket.head('missing'), null);
    assert.equal(await bucket.get('missing'), null);
    const response = await ready(database, bucket);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {status: 'ok'});
  });
});

for (const code of ['ContainerNotFound', 'ResourceNotFound', 'AuthorizationFailure']) {
  test(`Azure ${code} propagates and prevents a healthy deployment`, async () => {
    await fixture(code, async ({bucket, database}) => {
      const expected = error => (error.details?.errorCode ?? error.code) === code && error.statusCode === (code === 'AuthorizationFailure' ? 403 : 404);
      await assert.rejects(bucket.head('__healthcheck__'), expected);
      await assert.rejects(bucket.get('missing'), expected);
      const response = await ready(database, bucket);
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), {status: 'unavailable'});
    });
  });
}

test('real Azure SDK responses preserve Blob metadata and streaming bytes', async () => {
  await fixture(undefined, async ({bucket, database, payload}) => {
    const metadata = await bucket.head('object');
    assert.equal(metadata.size, payload.length);
    assert.equal(metadata.httpEtag, '"fixture-etag"');
    assert.deepEqual(metadata.customMetadata, {sha256: 'fixture'});
    const headers = new Headers();
    metadata.writeHttpMetadata(headers);
    assert.equal(headers.get('Content-Type'), 'application/octet-stream');
    const object = await bucket.get('object');
    assert.ok(object.body instanceof ReadableStream);
    assert.deepEqual(Buffer.from(await object.arrayBuffer()), payload);
    assert.equal((await ready(database, bucket)).status, 200);
  });
});

test('readiness requires the newest shipped migration but tolerates a newer database', async () => {
  const database = await sourceDatabase();
  const bucket = {head: async () => null};
  try {
    const empty = await testDatabase({template: false});
    try { assert.equal((await ready(empty, bucket)).status, 503, 'empty database'); } finally { await empty.close(); }
    const {entries} = JSON.parse(readFileSync(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8'));
    const latest = `${entries.at(-1).tag}.sql`;
    const [row] = (await database.query(sql`SELECT name,checksum,applied_at FROM _serverdesk_migrations WHERE name=${latest}`));
    await database.exec(sql`DELETE FROM _serverdesk_migrations WHERE name=${latest}`);
    assert.equal((await ready(database, bucket)).status, 503, 'release activated without its migration');
    await database.exec(sql`INSERT INTO _serverdesk_migrations(name,checksum,applied_at) VALUES(${row.name},${row.checksum},${row.applied_at})`);
    assert.equal((await ready(database, bucket)).status, 200);
    await database.exec(sql`INSERT INTO _serverdesk_migrations(name,checksum,applied_at) VALUES('9999_future.sql','x',0)`);
    assert.equal((await ready(database, bucket)).status, 200, 'an older image stays ready after a newer compatible migration');
  } finally {
    database.close();
  }
});

// deploy/azure.mjs rules for Container Apps: a PostgreSQL URL to a non-local
// host with TLS and without a password, and DATABASE_PASSWORD as a secretRef.
test('the Azure rollout requires a remote PostgreSQL URL with TLS and the password as a secretRef', async () => {
  const {containerRuntime, migrationCommandAllowed} = await import('../../deploy/azure.mjs');
  const secretNames = ['session', 'pepper', 'job-key', 'db-password'];
  const resource = ({url = 'postgres://serverdesk@db.postgres.database.azure.com:5432/serverdesk?sslmode=require', password = {name: 'DATABASE_PASSWORD', secretRef: 'db-password'}, secrets = secretNames, extra = []} = {}) => ({
    identity: {type: 'SystemAssigned'},
    properties: {
      configuration: {secrets: secrets.map(name => ({name}))},
      template: {containers: [{env: [
        {name: 'DATABASE_URL', value: url}, ...(password ? [password] : []),
        {name: 'OBJECT_STORAGE_DRIVER', value: 'azure'}, {name: 'AZURE_STORAGE_CONTAINER', value: 'serverdesk'}, {name: 'AZURE_STORAGE_ACCOUNT_URL', value: 'https://fixture.blob.core.windows.net'},
        {name: 'SESSION_SECRET', secretRef: 'session'}, {name: 'PASSWORD_PEPPER', secretRef: 'pepper'}, {name: 'AGENT_JOB_SIGNING_KEY', secretRef: 'job-key'},
        {name: 'SITE_ORIGIN', value: 'https://serverdesk.example.com'}, ...extra,
      ]}]},
    },
  });
  assert.ok(containerRuntime(resource(), 'App'), 'a valid configuration passes');
  assert.ok(containerRuntime(resource({url: 'postgresql://serverdesk@db.example.com:5432/serverdesk?sslmode=verify-full'}), 'App'), 'verify-full and postgresql: pass');
  for (const [label, options, message] of [
    ['a URL of another database', {url: 'mysql://serverdesk@db.example.com:3306/serverdesk'}, /must be a PostgreSQL URL/],
    ['no URL', {url: ''}, /configure DATABASE_URL as postgres:\/\//],
    ['a local host', {url: 'postgres://serverdesk@localhost:5432/serverdesk?sslmode=require'}, /local database host is forbidden/],
    ['the Compose host db', {url: 'postgres://serverdesk@db:5432/serverdesk?sslmode=require'}, /local database host is forbidden/],
    ['no sslmode', {url: 'postgres://serverdesk@db.example.com:5432/serverdesk'}, /needs TLS/],
    ['sslmode=prefer', {url: 'postgres://serverdesk@db.example.com:5432/serverdesk?sslmode=prefer'}, /needs TLS/],
    ['sslmode=verify-ca', {url: 'postgres://serverdesk@db.example.com:5432/serverdesk?sslmode=verify-ca'}, /needs TLS/],
    ['a password in the URL', {url: 'postgres://serverdesk:secret@db.example.com:5432/serverdesk?sslmode=require'}, /must not contain a password/],
    ['DATABASE_PASSWORD as a plain value', {password: {name: 'DATABASE_PASSWORD', value: 'secret'}}, /DATABASE_PASSWORD must use a configured Container Apps secretRef/],
    ['no DATABASE_PASSWORD', {password: null}, /DATABASE_PASSWORD must use a configured Container Apps secretRef/],
    ['a secretRef without a configured secret', {secrets: ['session', 'pepper', 'job-key']}, /DATABASE_PASSWORD must use a configured Container Apps secretRef/],
  ]) assert.throws(() => containerRuntime(resource(options), 'App'), error => message.test(error.message) && !error.message.includes('secret@'), label);
  assert.equal(migrationCommandAllowed(['node', 'scripts/selfhost.mjs', 'migrate']), true);
  assert.equal(migrationCommandAllowed(['node', 'scripts/selfhost.mjs', 'migrate', '--skip-backup']), true, 'Azure may skip the backup: the server has point-in-time restore');
  assert.equal(migrationCommandAllowed(['node', 'scripts/selfhost.mjs', 'migrate', '--force']), false);
  const source = readFileSync(new URL('../../deploy/azure.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, new RegExp(['lib', 'sql'].join(''), 'i'), 'no rule of the former database driver is left');
});
