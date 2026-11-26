// The reminder to remove SESSION_SECRET_PREVIOUS after a SESSION_SECRET change
// (docs/self-hosting.md, "Change the session secret"). Plain JavaScript, so the
// portal (lib/server/console-data.ts), the startup check (runtime/startup.mjs) and the
// offline CLI (scripts/selfhost.mjs) share one definition of the encrypted
// columns and of "every stored secret uses the current key".
import { sql } from './database.mjs';
import { createKeyring, previousSecrets } from './secret-keyring.mjs';

/** The marker in mfa_accounts.secret_enc of an account whose TOTP secret moved to mfa_authenticators. */
export const authenticatorManaged = 'migrated:authenticator-managed';

/**
 * Every column that holds a TOTP secret encrypted with AAD = principal: the
 * table and its key. previous_secret_enc of a pending replacement is only a
 * compare-and-swap copy that is never decrypted, so it is not in this list.
 */
export const encryptedColumns = Object.freeze([
  Object.freeze({ table: 'mfa_authenticators', key: 'id' }),
  Object.freeze({ table: 'mfa_challenges', key: 'principal' }),
  Object.freeze({ table: 'mfa_authenticator_challenges', key: 'id' }),
  Object.freeze({ table: 'mfa_accounts', key: 'principal' }),
]);

/** The startup log line when SESSION_SECRET_PREVIOUS can go. It names no secret, kid or count. */
export const previousSecretWarning = 'ServerDesk: SESSION_SECRET_PREVIOUS is still set, but every stored secret uses the current SESSION_SECRET. Remove SESSION_SECRET_PREVIOUS and restart the portal.';

const storedValues = sql.join(encryptedColumns.map(({ table }) => sql`SELECT secret_enc FROM ${sql.ident(table)}`), sql` UNION ALL `);

/**
 * The keyring when SESSION_SECRET_PREVIOUS names a secret other than the
 * current one, else null. Throws like createKeyring for a short secret.
 * @param {{ SESSION_SECRET?: unknown, SESSION_SECRET_PREVIOUS?: unknown }} env
 */
function rotationKeyring(env) {
  if (!previousSecrets(env?.SESSION_SECRET_PREVIOUS).length) return null;
  const ring = createKeyring(env);
  return ring.previous.length ? ring : null;
}

/**
 * configured: SESSION_SECRET_PREVIOUS names a secret other than SESSION_SECRET.
 * pending: the stored values (the sentinel excluded) that do not carry the kid
 * of the current secret. Without a previous secret no query runs. The result
 * holds no secret and no kid.
 * @param {{ one(statement: unknown): Promise<Record<string, unknown> | null> }} database
 * @param {{ SESSION_SECRET?: unknown, SESSION_SECRET_PREVIOUS?: unknown }} env
 * @returns {Promise<{ configured: boolean, pending: number }>}
 */
export async function previousSecretStatus(database, env) {
  const ring = rotationKeyring(env);
  if (!ring) return { configured: false, pending: 0 };
  const prefix = `k1.${await ring.current.keyId()}.`;
  const row = await database.one(sql`SELECT count(*) AS pending FROM (${storedValues}) stored WHERE secret_enc <> ${authenticatorManaged} AND NOT starts_with(secret_enc, ${prefix})`);
  return { configured: true, pending: Number(row?.pending ?? 0) };
}

/** True when SESSION_SECRET_PREVIOUS is set but no stored value needs it any more. */
export const previousSecretRemovableStatus = (/** @type {{ configured: boolean, pending: number }} */ status) => status.configured && status.pending === 0;

/**
 * The console notice: removable or not. The reminder is optional, so a broken
 * configuration or a failed query gives false instead of an error.
 * @param {{ one(statement: unknown): Promise<Record<string, unknown> | null> }} database
 * @param {{ SESSION_SECRET?: unknown, SESSION_SECRET_PREVIOUS?: unknown }} env
 * @returns {Promise<boolean>}
 */
export async function previousSecretRemovable(database, env) {
  try {
    return previousSecretRemovableStatus(await previousSecretStatus(database, env));
  } catch {
    return false;
  }
}

/**
 * The startup check. Only with a previous secret it opens a connection (one,
 * closed again), and it writes exactly one warning when the status is
 * removable. Any error writes nothing and never rejects, so the caller does
 * not await it and the start never waits for the database.
 * @param {{ env?: Record<string, string | undefined>, openDatabase?: (env: Record<string, string | undefined>) => { one(statement: unknown): Promise<Record<string, unknown> | null>, close(): Promise<void> } | Promise<{ one(statement: unknown): Promise<Record<string, unknown> | null>, close(): Promise<void> }>, warn?: (message: string) => void }} [options]
 * @returns {Promise<boolean>} true when it wrote the warning
 */
export async function checkPreviousSecretAtStartup({ env = process.env, openDatabase = defaultDatabase, warn = message => console.warn(message) } = {}) {
  try {
    if (!rotationKeyring(env)) return false;
    const database = await openDatabase(env);
    try {
      if (!previousSecretRemovableStatus(await previousSecretStatus(database, env))) return false;
    } finally {
      await database.close().catch(() => {});
    }
    warn(previousSecretWarning);
    return true;
  } catch {
    return false;
  }
}

/** @param {Record<string, string | undefined>} env */
async function defaultDatabase(env) {
  const { createDatabase } = await import('./database.mjs');
  return createDatabase({ url: env.DATABASE_URL, password: env.DATABASE_PASSWORD, max: 1 });
}
