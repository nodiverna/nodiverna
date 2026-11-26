// reset-totp in scripts/selfhost.mjs: after SESSION_SECRET leaked together
// with a copy of the database, it deletes every stored TOTP secret in one
// transaction. Passkeys stay, accounts without a passkey enroll again, and the
// MFA sessions and proofs of every affected account end.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { createDatabase, sql } from '../../runtime/database.mjs';
import { createKeyring, encryptWithKeyring } from '../../runtime/secret-keyring.mjs';
import { migrateDatabase, resetTotp, resetTotpConfirmMessage } from '../../scripts/selfhost.mjs';
import { inTransaction, sourceDatabase } from '../support/source-database.mjs';
import { createTestDatabase, testDatabase } from '../support/postgres.mjs';
import { serverDeskRoot } from '../support/paths.mjs';

const projectRoot = serverDeskRoot;
const secret = 'reset-totp-secret-' + 'r'.repeat(40);
const sentinel = 'migrated:authenticator-managed';
const seeds = ['JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', 'KRSXG5CTMVRXEZLUKRSXG5CTMVRXEZLU', 'MFRGGZDFMZTWQ2LKMFRGGZDFMZTWQ2LK', 'NBSWY3DPO5XXE3DENBSWY3DPO5XXE3DE', 'ORSXG5BRGIZTINJWG44DSMBROIZDMMZQ'];
const principals = { totp: 'local:totp-only', mixed: 'local:mixed', passkey: 'local:passkey-only', pending: 'local:pending-setup', legacy: 'local:legacy', none: 'local:no-mfa' };
const tables = {
  mfa_accounts: 'principal', mfa_authenticators: 'id', mfa_challenges: 'principal', mfa_authenticator_challenges: 'id',
  mfa_sessions: 'token_hash', mfa_grants: 'token_hash', mfa_proofs: 'token_hash', mfa_management_proofs: 'token_hash',
  passkey_credentials: 'id', mfa_attempts: 'principal',
};

// A TOTP-only account with sessions, an MFA grant and proofs; an
// account with an authenticator, a pending replacement and a passkey; a
// passkey-only account; a pending first setup without an account; an old
// account that keeps its secret in mfa_accounts; a principal without MFA.
async function seed(database) {
  const ring = createKeyring({ SESSION_SECRET: secret }), at = Date.now(), later = at + 3_600_000;
  const encrypt = (value, principal) => encryptWithKeyring(ring, value, principal);
  const totpValue = await encrypt(seeds[0], principals.totp), mixedValue = await encrypt(seeds[1], principals.mixed);
  const session = (token, principal) => sql`INSERT INTO mfa_sessions(token_hash,principal,created_at,last_activity,idle_expires_at,expires_at) VALUES(${token},${principal},${at},${at},${later},${later})`;
  // An MFA grant needs its account row (mfa_grants.user_id).
  const grant = (token, principal) => sql`WITH grant_user AS (INSERT INTO local_users(id,username,display_name,auth_principal,auth_email,created_at,updated_at) VALUES(${'user-' + token},${'user-' + token},'Fixture',${principal},${token + '@local.test'},${at},${at}) RETURNING id) INSERT INTO mfa_grants(token_hash,principal,user_id,created_at,expires_at) SELECT ${token},${principal},id,${at},${later} FROM grant_user`;
  const account = (principal, value, recovery, migrated) => sql`INSERT INTO mfa_accounts(principal,secret_enc,recovery_hashes,last_counter,created_at,authenticators_migrated) VALUES(${principal},${value},${recovery},7,${at - 1000},${migrated})`;
  const passkey = (id, principal) => sql`INSERT INTO passkey_credentials(id,principal,public_key,counter,transports,name,device,device_type,backed_up,created_at) VALUES(${id},${principal},'public-key',3,'["internal"]','Passkey','Laptop','multiDevice',1,${at})`;
  await inTransaction(database, [
    account(principals.totp, sentinel, '["totp-recovery"]', 1),
    sql`INSERT INTO mfa_authenticators(id,principal,name,secret_enc,last_counter,created_at,last_used_at) VALUES('auth-totp',${principals.totp},'Phone',${totpValue},-1,${at},NULL)`,
    session('session-totp', principals.totp), grant('grant-totp', principals.totp),
    sql`INSERT INTO mfa_proofs(token_hash,principal,expires_at) VALUES('proof-totp',${principals.totp},${later})`,
    sql`INSERT INTO mfa_management_proofs(token_hash,principal,session_hash,expires_at) VALUES('management-totp',${principals.totp},'session-totp',${later})`,
    sql`INSERT INTO mfa_attempts(principal,attempts,window_at,blocked_until) VALUES(${principals.totp},1,${at},0)`,

    account(principals.mixed, sentinel, '["mixed-1","mixed-2"]', 1),
    sql`INSERT INTO mfa_authenticators(id,principal,name,secret_enc,last_counter,created_at,last_used_at) VALUES('auth-mixed',${principals.mixed},'Tablet',${mixedValue},-1,${at},NULL)`,
    sql`INSERT INTO mfa_authenticator_challenges(id,principal,session_hash,authenticator_id,previous_secret_enc,name,secret_enc,expires_at) VALUES('replace-mixed',${principals.mixed},'session-mixed','auth-mixed',${mixedValue},'Tablet',${await encrypt(seeds[2], principals.mixed)},${later})`,
    passkey('passkey-mixed', principals.mixed), session('session-mixed', principals.mixed), grant('grant-mixed', principals.mixed),
    sql`INSERT INTO mfa_management_proofs(token_hash,principal,session_hash,expires_at) VALUES('management-mixed',${principals.mixed},'session-mixed',${later})`,

    account(principals.passkey, sentinel, '["passkey-recovery"]', 1),
    passkey('passkey-only', principals.passkey), session('session-passkey', principals.passkey), grant('grant-passkey', principals.passkey),
    sql`INSERT INTO mfa_proofs(token_hash,principal,expires_at) VALUES('proof-passkey',${principals.passkey},${later})`,

    sql`INSERT INTO mfa_challenges(principal,secret_enc,expires_at) VALUES(${principals.pending},${await encrypt(seeds[3], principals.pending)},${at + 600_000})`,

    account(principals.legacy, await encrypt(seeds[4], principals.legacy), '["legacy-recovery"]', 0),
    session('session-legacy', principals.legacy),

    sql`INSERT INTO mfa_attempts(principal,attempts,window_at,blocked_until) VALUES(${principals.none},2,${at},0)`,
  ]);
}

// Every row of the MFA tables, ordered by key.
async function snapshot(database) {
  const result = {};
  for (const [table, key] of Object.entries(tables)) result[table] = await database.query(sql`SELECT * FROM ${sql.ident(table)} ORDER BY ${sql.ident(key)}`);
  return result;
}
const rowsOf = (state, table, principal) => state[table].filter(row => row.principal === principal);
const resetAudit = database => database.query(sql`SELECT actor,action,target,server_id,scope,customer_id FROM audit WHERE action='TOTP authenticators reset' ORDER BY id`);
const auditRow = target => ({ actor: 'System', action: 'TOTP authenticators reset', target, server_id: null, scope: 'portal', customer_id: null });

async function migrated(run) {
  const database = await sourceDatabase();
  try { return await run(database); } finally { await database.close(); }
}

test('reset-totp without confirm changes nothing', () => migrated(async database => {
  await seed(database);
  const before = await snapshot(database);
  for (const options of [undefined, {}, { confirm: false }, { confirm: 'yes' }]) {
    await assert.rejects(resetTotp(database, options), { message: resetTotpConfirmMessage });
  }
  assert.deepEqual(await snapshot(database), before, 'rows stay byte-identical');
  assert.deepEqual(await resetAudit(database), [], 'no audit row');
}));

test('reset-totp removes every TOTP secret, keeps passkeys and ends the sessions of affected accounts', () => migrated(async database => {
  await seed(database);
  const before = await snapshot(database);
  const result = await resetTotp(database, { confirm: true });
  assert.deepEqual(result, { accounts: 4, authenticators: 2, pendingSetups: 2, passkeyOnly: 1, mfaRemoved: 2 });
  for (const value of Object.values(result)) assert.ok(Number.isSafeInteger(value), 'counters only');
  const text = JSON.stringify(result);
  for (const value of [...Object.values(principals), ...seeds, secret, 'k1.']) assert.ok(!text.includes(value), 'the output names no principal, secret or ciphertext');

  const after = await snapshot(database);
  for (const table of ['mfa_authenticators', 'mfa_challenges', 'mfa_authenticator_challenges']) assert.deepEqual(after[table], [], `${table} is empty`);
  assert.deepEqual(after.mfa_accounts.filter(row => row.secret_enc !== sentinel), [], 'no seed stays in mfa_accounts');

  // TOTP only and the old account: no anchor, no sessions, no proofs.
  for (const principal of [principals.totp, principals.legacy]) {
    for (const table of ['mfa_accounts', 'mfa_sessions', 'mfa_grants', 'mfa_proofs', 'mfa_management_proofs']) assert.deepEqual(rowsOf(after, table, principal), [], `${principal}: ${table}`);
  }
  // The mixed account is passkey-only now; recovery codes and created_at stay.
  const [mixedBefore] = rowsOf(before, 'mfa_accounts', principals.mixed), [mixedAfter] = rowsOf(after, 'mfa_accounts', principals.mixed);
  assert.deepEqual(mixedAfter, { ...mixedBefore, secret_enc: sentinel, authenticators_migrated: 1, last_counter: -1 });
  assert.equal(mixedAfter.recovery_hashes, '["mixed-1","mixed-2"]');
  assert.deepEqual(rowsOf(after, 'passkey_credentials', principals.mixed), rowsOf(before, 'passkey_credentials', principals.mixed), 'the passkey stays');
  for (const table of ['mfa_sessions', 'mfa_grants', 'mfa_management_proofs']) assert.deepEqual(rowsOf(after, table, principals.mixed), [], `mixed: ${table} ends`);
  // The passkey-only account and the principal without MFA are unchanged.
  for (const principal of [principals.passkey, principals.none]) {
    for (const table of Object.keys(tables)) assert.deepEqual(rowsOf(after, table, principal), rowsOf(before, table, principal), `${principal}: ${table} unchanged`);
  }
  assert.deepEqual(after.mfa_attempts, before.mfa_attempts, 'login attempts stay');

  const target = 'Accounts 4, authenticators 2, pending setups 2, passkey-only 1, MFA removed 2';
  assert.deepEqual(await resetAudit(database), [auditRow(target)], 'one audit row with counters only');

  // A second run finds nothing and only adds its own audit row.
  assert.deepEqual(await resetTotp(database, { confirm: true }), { accounts: 0, authenticators: 0, pendingSetups: 0, passkeyOnly: 0, mfaRemoved: 0 });
  assert.deepEqual(await snapshot(database), after, 'the second run changes no row');
  assert.deepEqual(await resetAudit(database), [auditRow(target), auditRow('Accounts 0, authenticators 0, pending setups 0, passkey-only 0, MFA removed 0')]);
}));

test('reset-totp rolls back everything when its audit row fails', () => migrated(async database => {
  await seed(database);
  const before = await snapshot(database);
  await database.exec(sql`ALTER TABLE audit ADD CONSTRAINT reset_audit_blocked CHECK (action <> 'TOTP authenticators reset')`);
  await assert.rejects(resetTotp(database, { confirm: true }), /reset_audit_blocked/);
  assert.deepEqual(await snapshot(database), before, 'one transaction: nothing changed');
}));

test('reset-totp refuses an unmigrated database', async () => {
  const unmigrated = await testDatabase({ template: false });
  try {
    await assert.rejects(resetTotp(unmigrated, { confirm: true }), { message: 'Apply all migrations with the command migrate before reset-totp.' });
  } finally { await unmigrated.close(); }
});

test('reset-totp CLI checks its arguments before it needs the database and prints counters only', async () => {
  const environment = { ...process.env };
  delete environment.DATABASE_URL;
  const cli = (args, env = environment) => spawnSync(process.execPath, ['scripts/selfhost.mjs', ...args], { cwd: projectRoot, env, encoding: 'utf8', timeout: 60000 });
  const unconfirmed = cli(['reset-totp']);
  assert.equal(unconfirmed.status, 1);
  assert.equal(unconfirmed.stderr, `ServerDesk: ${resetTotpConfirmMessage}\n`, 'refused before DATABASE_URL is read');
  for (const args of [['reset-totp', '--force'], ['reset-totp', '--confirm', '--force'], ['reset-totp', '--confirm', '--confirm'], ['reset-totp', 'confirm']]) {
    const run = cli(args);
    assert.equal(run.status, 1, args.join(' '));
    assert.equal(run.stderr, 'ServerDesk: reset-totp accepts only --confirm.\n', args.join(' '));
  }
  const help = cli(['--help']);
  assert.ok(help.stdout.includes('       node --env-file=.env.local scripts/selfhost.mjs reset-totp --confirm'));

  const target = await createTestDatabase({ template: false });
  try {
    const withDatabase = { ...environment, DATABASE_URL: target.url, DATABASE_PASSWORD: target.password };
    const unmigrated = cli(['reset-totp', '--confirm'], withDatabase);
    assert.equal(unmigrated.status, 1);
    assert.match(unmigrated.stderr, /^ServerDesk: Apply all migrations with the command migrate before reset-totp\.$/m);
    const database = createDatabase({ url: target.url, password: target.password, max: 2 });
    try { await migrateDatabase(database); await seed(database); } finally { await database.close(); }
    const run = cli(['reset-totp', '--confirm'], withDatabase);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, '');
    assert.deepEqual(JSON.parse(run.stdout), { accounts: 4, authenticators: 2, pendingSetups: 2, passkeyOnly: 1, mfaRemoved: 2 });
  } finally {
    await target.drop();
  }
});
