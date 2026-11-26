// SESSION_SECRET rotation without data loss: the keyring in
// runtime/secret-keyring.mjs, the portal path in lib/server/identity/mfa.ts and the offline
// command rewrap-secrets in scripts/selfhost.mjs.
import {serverText} from '../support/server-text.mjs';
import {HttpError as realHttpError} from '../support/http-error.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import nodeCrypto from 'node:crypto';
import test from 'node:test';
import {createDatabase,sql} from '../../runtime/database.mjs';
import { createKeyring, decryptWithKeyring, deriveKeyBytes, encryptWithKeyring, keyId, needsRewrap, previousSecretMessage } from '../../runtime/secret-keyring.mjs';
import { previousSecretStatus } from '../../runtime/previous-secret.mjs';
import { migrateDatabase, rewrapFailureMessage, rewrapSecrets } from '../../scripts/selfhost.mjs';
import {sourceLoader,sourceDatabase,inTransaction} from '../support/source-database.mjs';
import {hookDatabase} from '../support/hooked-database.mjs';
import {createTestDatabase,testDatabase} from '../support/postgres.mjs';
import { serverDeskRoot } from '../support/paths.mjs';

const projectRoot = serverDeskRoot;
const A = 'rotation-secret-A-' + 'a'.repeat(40), B = 'rotation-secret-B-' + 'b'.repeat(40), C = 'rotation-secret-C-' + 'c'.repeat(40);
const sentinel = 'migrated:authenticator-managed';
const plaintexts = { first: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', current: 'KRSXG5CTMVRXEZLUKRSXG5CTMVRXEZLU', challenge: 'MFRGGZDFMZTWQ2LKMFRGGZDFMZTWQ2LK', replacement: 'NBSWY3DPO5XXE3DENBSWY3DPO5XXE3DE' };

// The format from before the keyring, rebuilt with node:crypto: SHA-256 key,
// AES-GCM, <iv>.<data>. The keyring no longer reads it.
function oldFormatEncrypt(secret, value, context) {
  const key = nodeCrypto.createHash('sha256').update('ServerDesk:v3:encrypted-secrets:' + secret).digest();
  const iv = nodeCrypto.randomBytes(12), cipher = nodeCrypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context));
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return iv.toString('base64url') + '.' + data.toString('base64url');
}

async function migrated(run) {
  const database = await sourceDatabase();
  try {
    return await run(database);
  } finally { database.close(); }
}

// Seeds every encrypted column under secret A: two authenticators, an
// enrollment challenge, a pending replacement of the first authenticator and an
// account with the sentinel.
async function seed(database) {
  const ringA = createKeyring({ SESSION_SECRET: A }), at = Date.now();
  const rows = {
    first: { id: 'auth-first', principal: 'local:alice', value: await encryptWithKeyring(ringA, plaintexts.first, 'local:alice') },
    current: { id: 'auth-k1', principal: 'local:bob', value: await encryptWithKeyring(ringA, plaintexts.current, 'local:bob') },
    challenge: { id: 'local:carol', principal: 'local:carol', value: await encryptWithKeyring(ringA, plaintexts.challenge, 'local:carol') },
    replacement: { id: 'replace-1', principal: 'local:alice', value: await encryptWithKeyring(ringA, plaintexts.replacement, 'local:alice') },
  };
  await inTransaction(database,[
    sql`INSERT INTO mfa_authenticators(id,principal,name,secret_enc,last_counter,created_at,last_used_at) VALUES(${rows.first.id},${rows.first.principal},'Authenticator',${rows.first.value},-1,${at},NULL)`,
    sql`INSERT INTO mfa_authenticators(id,principal,name,secret_enc,last_counter,created_at,last_used_at) VALUES(${rows.current.id},${rows.current.principal},'Authenticator',${rows.current.value},-1,${at},NULL)`,
    sql`INSERT INTO mfa_challenges(principal,secret_enc,expires_at) VALUES(${rows.challenge.principal},${rows.challenge.value},${at + 600000})`,
    sql`INSERT INTO mfa_authenticator_challenges(id,principal,session_hash,authenticator_id,previous_secret_enc,name,secret_enc,expires_at) VALUES(${rows.replacement.id},${rows.replacement.principal},'session',${rows.first.id},${rows.first.value},'Neu',${rows.replacement.value},${at + 300000})`,
    sql`INSERT INTO mfa_accounts(principal,secret_enc,recovery_hashes,last_counter,created_at,authenticators_migrated) VALUES('local:alice',${sentinel},'[]',-1,${at},1)`,
  ]);
  return rows;
}

async function stored(database) {
  const one = statement => database.one(statement);
  return {
    first: (await one(sql`SELECT secret_enc FROM mfa_authenticators WHERE id='auth-first'`)).secret_enc,
    current: (await one(sql`SELECT secret_enc FROM mfa_authenticators WHERE id='auth-k1'`)).secret_enc,
    challenge: (await one(sql`SELECT secret_enc FROM mfa_challenges WHERE principal='local:carol'`)).secret_enc,
    replacement: (await one(sql`SELECT secret_enc FROM mfa_authenticator_challenges WHERE id='replace-1'`)).secret_enc,
    previous: (await one(sql`SELECT previous_secret_enc FROM mfa_authenticator_challenges WHERE id='replace-1'`)).previous_secret_enc,
    account: (await one(sql`SELECT secret_enc FROM mfa_accounts WHERE principal='local:alice'`)).secret_enc,
  };
}

// The audit rows of rewrap-secrets, oldest first.
async function rewrapAudit(database) {
  return database.query(sql`SELECT actor,action,target,server_id,scope,customer_id FROM audit WHERE action='Secrets rewrapped' ORDER BY id`);
}
const rewrapRow = target => ({ actor: 'System', action: 'Secrets rewrapped', target, server_id: null, scope: 'portal', customer_id: null });

function assertNoSecrets(text) {
  for (const secret of [A, B, C, ...Object.values(plaintexts)]) assert.ok(!text.includes(secret), 'the output names no secret and no plaintext');
  assert.ok(!/[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/.test(text), 'the output holds no ciphertext');
}

test('keyring derives separate keys and a public kid per secret', async () => {
  const first = await deriveKeyBytes(A, 'encrypted-secrets');
  assert.equal(first.byteLength, 32);
  assert.deepEqual(await deriveKeyBytes(A, 'encrypted-secrets'), first, 'deterministic');
  assert.notDeepEqual(await deriveKeyBytes(A, 'device-token-challenges'), first, 'another purpose gives other bytes');
  assert.notDeepEqual(await deriveKeyBytes(B, 'encrypted-secrets'), first, 'another secret gives other bytes');
  const [kidA, kidB] = [await keyId(A), await keyId(B)];
  assert.match(kidA, /^[0-9a-f]{16}$/);
  assert.equal(await keyId(A), kidA);
  assert.notEqual(kidA, kidB);
  assert.ok(!A.includes(kidA) && !Buffer.from(A).toString('hex').includes(kidA), 'the kid does not contain the secret');
});

test('createKeyring checks every secret and ignores empty and current entries', async () => {
  assert.throws(() => createKeyring({}), /SESSION_SECRET must/);
  assert.throws(() => createKeyring({ SESSION_SECRET: 'short' }), /SESSION_SECRET must/);
  assert.throws(() => createKeyring({ SESSION_SECRET: B, SESSION_SECRET_PREVIOUS: 'short' }), { message: previousSecretMessage });
  assert.throws(() => createKeyring({ SESSION_SECRET: B, SESSION_SECRET_PREVIOUS: `${A},short` }), { message: previousSecretMessage });
  // 16 characters 'ä' are 32 bytes: the limit counts UTF-8 bytes, not characters.
  assert.equal(createKeyring({ SESSION_SECRET: 'ä'.repeat(16) }).previous.length, 0);
  assert.equal(createKeyring({ SESSION_SECRET: B, SESSION_SECRET_PREVIOUS: '' }).previous.length, 0);
  assert.equal(createKeyring({ SESSION_SECRET: B, SESSION_SECRET_PREVIOUS: ` , ${A} ,,${B}, ${A}` }).previous.length, 1, 'empty, current and repeated entries are ignored');
  const ring = createKeyring({ SESSION_SECRET: B, SESSION_SECRET_PREVIOUS: ` ${A} , ` });
  assert.equal(await ring.previous[0].keyId(), await keyId(A), 'whitespace is trimmed');
  assert.ok(!JSON.stringify(ring).includes(A) && !JSON.stringify(ring).includes(B), 'the ring object gives out no secret');
});

test('encryption round-trips, binds the context and selects the key by kid', async () => {
  const ringA = createKeyring({ SESSION_SECRET: A }), ringB = createKeyring({ SESSION_SECRET: B }), rotated = createKeyring({ SESSION_SECRET: B, SESSION_SECRET_PREVIOUS: A });
  const value = await encryptWithKeyring(ringA, plaintexts.current, 'local:bob');
  const [prefix, kid, iv, data, ...rest] = value.split('.');
  assert.deepEqual([prefix, kid, rest], ['k1', await keyId(A), []]);
  assert.match(iv, /^[A-Za-z0-9_-]{16}$/);
  assert.match(data, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(await encryptWithKeyring(ringA, plaintexts.current, 'local:bob'), value, 'a fresh IV per value');
  assert.equal(await decryptWithKeyring(ringA, value, 'local:bob'), plaintexts.current);
  assert.equal(await decryptWithKeyring(rotated, value, 'local:bob'), plaintexts.current, 'a previous kid stays readable');
  await assert.rejects(decryptWithKeyring(ringA, value, 'local:mallory'), 'a wrong context fails');
  await assert.rejects(decryptWithKeyring(ringB, value, 'local:bob'), /Unknown key/, 'an unknown kid fails');
  await assert.rejects(decryptWithKeyring(ringA, `k1.${kid}.${iv}.${data.slice(0, -2)}AA`, 'local:bob'), 'a changed ciphertext fails');
  for (const bad of ['', 'garbage', 'k1.zz.a.b', `k2.${kid}.${iv}.${data}`, `k1.${kid}.${iv}`, 'a.b.c', `k1.${kid}.${iv}.${data}.x`, '!!.??']) {
    await assert.rejects(decryptWithKeyring(ringA, bad, 'local:bob'), `bad format: ${bad}`);
  }
  assert.equal(await needsRewrap(ringA, value), false, 'current kid');
  assert.equal(await needsRewrap(rotated, value), true, 'old kid');
  assert.equal(await needsRewrap(rotated, await encryptWithKeyring(rotated, 'x', 'c')), false);
  assert.equal(await needsRewrap(ringA, oldFormatEncrypt(A, 'x', 'c')), true, 'the old format');
});

test('a value in the old <iv>.<data> format no longer decrypts, not even with its own secret', async () => {
  const value = oldFormatEncrypt(A, plaintexts.first, 'local:alice');
  for (const env of [{ SESSION_SECRET: A }, { SESSION_SECRET: B, SESSION_SECRET_PREVIOUS: A }, { SESSION_SECRET: B, SESSION_SECRET_PREVIOUS: `${C},${A}` }]) {
    await assert.rejects(decryptWithKeyring(createKeyring(env), value, 'local:alice'), { message: 'Invalid ciphertext.' });
  }
});

test('rewrap-secrets rotates every stored value without data loss', () => migrated(async database => {
  const rows = await seed(database), ringB = createKeyring({ SESSION_SECRET: B }), rotated = createKeyring({ SESSION_SECRET: B, SESSION_SECRET_PREVIOUS: A });
  for (const [name, row] of Object.entries(rows)) {
    await assert.rejects(decryptWithKeyring(ringB, row.value, row.principal), `${name}: B alone cannot read it before the rewrap`);
    assert.equal(await decryptWithKeyring(rotated, row.value, row.principal), plaintexts[name], `${name}: B with previous A reads it`);
  }
  const result = await rewrapSecrets(database, { env: { SESSION_SECRET: B, SESSION_SECRET_PREVIOUS: A } });
  assert.deepEqual(result, { keyId: await keyId(B), checked: 4, rewrapped: 4, unchanged: 0, failed: 0 });
  assertNoSecrets(JSON.stringify(result));
  const after = await stored(database);
  for (const name of Object.keys(rows)) {
    assert.ok(after[name].startsWith(`k1.${await keyId(B)}.`), `${name} carries the kid of B`);
    assert.equal(await decryptWithKeyring(ringB, after[name], rows[name].principal), plaintexts[name], `${name} decrypts with B alone`);
  }
  assert.equal(after.previous, after.first, 'the pending replacement follows the authenticator');
  assert.equal(after.account, sentinel, 'the sentinel stays');
  assert.deepEqual(await rewrapAudit(database), [rewrapRow(`Key ${await keyId(B)}, checked 4, rewrapped 4, unchanged 0, failed 0`)], 'one audit row with the kid and the counters');
  const again = await rewrapSecrets(database, { env: { SESSION_SECRET: B } });
  assert.deepEqual(again, { keyId: await keyId(B), checked: 4, rewrapped: 0, unchanged: 4, failed: 0 }, 'a second run, now without the previous secret, rewraps nothing');
  assert.deepEqual(await stored(database), after);
  assert.deepEqual(await rewrapAudit(database), [
    rewrapRow(`Key ${await keyId(B)}, checked 4, rewrapped 4, unchanged 0, failed 0`),
    rewrapRow(`Key ${await keyId(B)}, checked 4, rewrapped 0, unchanged 4, failed 0`),
  ], 'the second run adds its own row');
  assertNoSecrets(JSON.stringify(await rewrapAudit(database)));
}));

test('rewrap-secrets leaves values it cannot read and refuses an unmigrated database', async () => {
  await migrated(async database => {
    await seed(database);
    const before = await stored(database);
    const result = await rewrapSecrets(database, { env: { SESSION_SECRET: B } });
    assert.deepEqual(result, { keyId: await keyId(B), checked: 4, rewrapped: 0, unchanged: 0, failed: 4 });
    assert.deepEqual(await stored(database), before, 'rows stay byte-identical');
    assertNoSecrets(JSON.stringify(result));
    await assert.rejects(rewrapSecrets(database, { env: { SESSION_SECRET: B, SESSION_SECRET_PREVIOUS: 'short' } }), { message: previousSecretMessage });
    await assert.rejects(rewrapSecrets(database, { env: { SESSION_SECRET: 'short' } }), /SESSION_SECRET must/);
    assert.deepEqual(await stored(database), before);
    assert.deepEqual(await rewrapAudit(database), [rewrapRow(`Key ${await keyId(B)}, checked 4, rewrapped 0, unchanged 0, failed 4`)], 'a run with failures writes its row; the rejected runs write none');
    assertNoSecrets(JSON.stringify(await rewrapAudit(database)));
  });
  // An empty database without the schema.
  const unmigrated = await testDatabase({ template: false });
  try {
    await assert.rejects(rewrapSecrets(unmigrated, { env: { SESSION_SECRET: B, SESSION_SECRET_PREVIOUS: A } }), { message: 'Apply all migrations with the command migrate before rewrap-secrets.' });
    assert.equal((await unmigrated.one(sql`SELECT to_regclass('public.audit') AS present`)).present, null, 'an unmigrated database gets no audit table and no row');
  } finally { await unmigrated.close(); }
});

test('a compare-and-swap miss counts as unchanged and keeps the portal value', () => migrated(async database => {
  const rows = await seed(database), ringA = createKeyring({ SESSION_SECRET: A });
  // The portal replaces the first authenticator right before its rewrap commits.
  const portalValue = await encryptWithKeyring(ringA, 'PORTALCHANGEPORTALCHANGEPORTALCH', rows.first.principal);
  let raced = false;
  const racing = hookDatabase(database, { transaction: async () => {
    if (!raced) { raced = true; await database.exec(sql`UPDATE mfa_authenticators SET secret_enc=${portalValue} WHERE id='auth-first'`); }
  } });
  const result = await rewrapSecrets(racing, { env: { SESSION_SECRET: B, SESSION_SECRET_PREVIOUS: A } });
  assert.deepEqual({ ...result, keyId: undefined }, { keyId: undefined, checked: 4, rewrapped: 3, unchanged: 1, failed: 0 });
  const after = await stored(database);
  assert.equal(after.first, portalValue, 'the portal change wins');
  assert.equal(after.previous, rows.first.value, 'the replacement guard only moves with a committed rewrap');
  assert.equal((await rewrapSecrets(database, { env: { SESSION_SECRET: B, SESSION_SECRET_PREVIOUS: A } })).rewrapped, 1, 'a re-run finishes the remainder');
}));

test('rewrap-secrets counts old-format values as failed and leaves them unchanged', () => migrated(async database => {
  const account = oldFormatEncrypt(A, plaintexts.first, 'local:dave'), authenticator = oldFormatEncrypt(A, plaintexts.current, 'local:erin');
  await inTransaction(database,[
    sql`INSERT INTO mfa_accounts(principal,secret_enc,recovery_hashes,last_counter,created_at,authenticators_migrated) VALUES('local:dave',${account},'[]',-1,0,0)`,
    sql`INSERT INTO mfa_authenticators(id,principal,name,secret_enc,last_counter,created_at,last_used_at) VALUES('auth-old','local:erin','Authenticator',${authenticator},-1,0,NULL)`,
  ]);
  for (const env of [{ SESSION_SECRET: A }, { SESSION_SECRET: B, SESSION_SECRET_PREVIOUS: A }]) {
    assert.deepEqual(await rewrapSecrets(database, { env }), { keyId: await keyId(env.SESSION_SECRET), checked: 2, rewrapped: 0, unchanged: 0, failed: 2 });
  }
  assert.equal(await database.one(sql`SELECT secret_enc FROM mfa_accounts WHERE principal='local:dave'`).then(row=>row===null?null:row.secret_enc), account);
  assert.equal(await database.one(sql`SELECT secret_enc FROM mfa_authenticators WHERE id='auth-old'`).then(row=>row===null?null:row.secret_enc), authenticator);
}));

test('previousSecretStatus counts the values that still need a previous secret', async () => {
  // Without a previous secret no query runs.
  const refusing = { one: async () => { throw new Error('no query without a previous secret'); } };
  for (const env of [{ SESSION_SECRET: B }, { SESSION_SECRET: B, SESSION_SECRET_PREVIOUS: '' }, { SESSION_SECRET: B, SESSION_SECRET_PREVIOUS: ` ${B} , ` }]) {
    assert.deepEqual(await previousSecretStatus(refusing, env), { configured: false, pending: 0 }, 'a previous entry equal to the current secret counts as not set');
  }
  await migrated(async database => {
    const rotated = { SESSION_SECRET: B, SESSION_SECRET_PREVIOUS: A };
    assert.deepEqual(await previousSecretStatus(database, rotated), { configured: true, pending: 0 }, 'no stored value: removable');
    await seed(database);
    const before = await previousSecretStatus(database, rotated);
    assert.deepEqual(before, { configured: true, pending: 4 }, 'four values under A; the sentinel is not counted');
    assertNoSecrets(JSON.stringify(before));
    assert.ok(!JSON.stringify(before).includes(await keyId(B)) && !JSON.stringify(before).includes(await keyId(A)), 'no kid in the status');
    await rewrapSecrets(database, { env: rotated });
    assert.deepEqual(await previousSecretStatus(database, rotated), { configured: true, pending: 0 }, 'after the rewrap to B');
    assert.deepEqual(await previousSecretStatus(database, { SESSION_SECRET: A, SESSION_SECRET_PREVIOUS: B }), { configured: true, pending: 4 }, 'measured against the current kid');
  });
});

test('the portal encrypts with the current kid and reads values of the previous secret', async () => {
  const HttpError=realHttpError;
  let settings = { SESSION_SECRET: B, SESSION_SECRET_PREVIOUS: A };
  const server = { config: key => settings[key] ?? '', db: () => { throw new Error('no database in this test'); }, hash: async value => nodeCrypto.createHash('sha256').update(value).digest('hex'), HttpError, now: () => Date.now(), random: () => nodeCrypto.randomBytes(32).toString('hex') };
  const mfa = sourceLoader()('lib/server/identity/mfa.ts', { '../context': server,'./context':server, '../../context': server, '@/lib/server/context': server, '@simplewebauthn/server': {} });
  const encrypted = await mfa.encryptSecret(plaintexts.current, 'local:bob');
  assert.ok(encrypted.startsWith(`k1.${await keyId(B)}.`));
  assert.equal(await mfa.decryptSecret(encrypted, 'local:bob'), plaintexts.current);
  assert.equal(await mfa.decryptSecret(await encryptWithKeyring(createKeyring({ SESSION_SECRET: A }), plaintexts.first, 'local:alice'), 'local:alice'), plaintexts.first, 'a value of the previous secret stays readable');
  // A value in the old format is unreadable, also under its own secret.
  settings = { SESSION_SECRET: A };
  await assert.rejects(mfa.decryptSecret(oldFormatEncrypt(A, plaintexts.first, 'local:alice'), 'local:alice'), { status: 503, message: serverText('apiError.mfa.secretUndecryptable') });
  assert.ok((await mfa.encryptSecret('x', 'c')).startsWith(`k1.${await keyId(A)}.`), 'a changed config builds a new ring');
  await assert.rejects(mfa.decryptSecret(encrypted, 'local:bob'), { status: 503, message: serverText('apiError.mfa.secretUndecryptable') });
  settings = { SESSION_SECRET: 'short' };
  assert.equal(mfa.mfaAvailable(), false);
  await assert.rejects(mfa.encryptSecret('x', 'c'), { status: 503, message: serverText('apiError.mfa.sessionKeyMissing') });
  await assert.rejects(mfa.decryptSecret(encrypted, 'local:bob'), { status: 503, message: serverText('apiError.mfa.sessionKeyMissing') });
});

test('rewrap-secrets CLI rejects arguments and short secrets, prints JSON and exits 1 on failures', async () => {
  // An empty test database; the CLI reads its address and password from the environment.
  const target = await createTestDatabase({ template: false });
  const environment = { ...process.env, DATABASE_URL: target.url, DATABASE_PASSWORD: target.password, SESSION_SECRET: B };
  delete environment.SESSION_SECRET_PREVIOUS;
  const cli = (args, env = environment) => spawnSync(process.execPath, ['scripts/selfhost.mjs', ...args], { cwd: projectRoot, env, encoding: 'utf8', timeout: 60000 });
  try {
    const extra = cli(['rewrap-secrets', '--force']);
    assert.equal(extra.status, 1);
    assert.match(extra.stderr, /^ServerDesk: rewrap-secrets accepts no further arguments\.$/m);
    const short = cli(['rewrap-secrets'], { ...environment, SESSION_SECRET_PREVIOUS: `${A},short` });
    assert.equal(short.status, 1);
    assert.match(short.stderr, /^ServerDesk: SESSION_SECRET_PREVIOUS contains an entry with fewer than 32 UTF-8 bytes\.$/m);
    const unmigrated = cli(['rewrap-secrets']);
    assert.equal(unmigrated.status, 1);
    assert.match(unmigrated.stderr, /^ServerDesk: Apply all migrations with the command migrate before rewrap-secrets\.$/m);

    const database = createDatabase({ url: target.url, password: target.password, max: 2 });
    try { await migrateDatabase(database); await seed(database); } finally { await database.close(); }
    const failing = cli(['rewrap-secrets']);
    assert.equal(failing.status, 1, failing.stderr);
    assert.ok(failing.stderr.includes(`ServerDesk: ${rewrapFailureMessage(4)}`));
    assert.deepEqual(JSON.parse(failing.stdout), { keyId: await keyId(B), checked: 4, rewrapped: 0, unchanged: 0, failed: 4 });
    const rotating = cli(['rewrap-secrets'], { ...environment, SESSION_SECRET_PREVIOUS: A });
    assert.equal(rotating.status, 0, rotating.stderr);
    assert.equal(rotating.stderr, '');
    assert.deepEqual(JSON.parse(rotating.stdout), { keyId: await keyId(B), checked: 4, rewrapped: 4, unchanged: 0, failed: 0 });
    for (const run of [failing, rotating]) assertNoSecrets(run.stdout + run.stderr);

    const help = cli(['--help']);
    assert.ok(help.stdout.includes('       node --env-file=.env.local scripts/selfhost.mjs rewrap-secrets'));
  } finally {
    await target.drop();
  }
});
