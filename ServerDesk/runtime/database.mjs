import postgres from 'postgres';
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The application's data layer on PostgreSQL (postgres.js).
 *
 * SQL text comes only from the tagged template `sql`; every interpolated value
 * becomes a bind parameter, a nested `sql` fragment is inlined with its own
 * parameters renumbered. A database object has exactly query, one, exec,
 * transaction and close. Each connection runs at SERIALIZABLE, and a
 * serialization failure or deadlock (SQLSTATE 40001, 40P01) runs the whole
 * statement or transaction callback again, at most `maxAttempts` (10) times
 * in total. Before each new attempt the call waits a random time with full
 * jitter (`retryDelay`): up to 10, 20, 40, 80 and 160 ms, then up to 250 ms
 * (`retryCapMs`), so all waits of one call add up to at most about 1.3 s.
 * The long tail lets a call outlast a conflicting transaction that runs for
 * a second under load, and the jitter spreads contenders on one hot row. A
 * callback must therefore have no effect outside the database that a second
 * run would repeat. Other errors are not retried.
 */

// Registry symbols (Symbol.for), not module-local ones: a pool that outlives a
// module reload (next dev drops the require cache) must still recognise the
// fragments and handles of the new module instance. Data from outside (JSON,
// form data, database rows) cannot carry a symbol key, so it never counts as SQL.
const fragment = Symbol.for('serverdesk.sql');
const rawHandle = Symbol.for('serverdesk.sql.handle');
const identifier = /^[a-z_][a-z0-9_]*$/;
export const maxAttempts = 10;
/** The base and the upper limit of the retry wait in milliseconds. */
export const retryBaseMs = 5;
export const retryCapMs = 250;
const retryCodes = new Set(['40001', '40P01']);

/**
 * The wait in milliseconds after the failed attempt `attempt` (1-based) and
 * before the next one: a random value from 0 to
 * min(retryCapMs, retryBaseMs * 2^attempt) ("full jitter"). `random` returns
 * a number in [0, 1).
 */
export function retryDelay(attempt, random = Math.random) {
  return random() * Math.min(retryCapMs, retryBaseMs * 2 ** attempt);
}

export class SqlFragment {
  constructor(parts, values) {
    this.parts = parts;
    this.values = values;
    Object.freeze(this);
  }
}
Object.defineProperty(SqlFragment.prototype, fragment, { value: true });

/** True only for fragments built by this module (in any of its loaded instances). */
export const isSql = value => value?.[fragment] === true;

function checkValue(value) {
  if (value === null || isSql(value)) return;
  switch (typeof value) {
    case 'string': case 'boolean': case 'bigint': return;
    case 'number': if (Number.isFinite(value)) return; throw new TypeError('An SQL parameter must be a finite number.');
    default: throw new TypeError(`An SQL parameter must be a string, a number, a boolean, null or an sql fragment, not ${value === undefined ? 'undefined' : Array.isArray(value) ? 'an array (pass JSON text)' : typeof value}.`);
  }
}

/** The tagged template: sql`SELECT id FROM servers WHERE id=${id}`. */
export function sql(strings, ...values) {
  if (!Array.isArray(strings) || !Array.isArray(strings.raw)) throw new TypeError('sql is a tagged template: write sql`...`.');
  values.forEach(checkValue);
  return new SqlFragment([...strings], values);
}

/** Joins fragments with a separator fragment (default ", "). */
sql.join = (fragments, separator = sql`, `) => {
  if (!Array.isArray(fragments) || fragments.some(item => !isSql(item))) throw new TypeError('sql.join needs an array of sql fragments.');
  if (!isSql(separator)) throw new TypeError('The separator of sql.join must be an sql fragment.');
  if (!fragments.length) return sql``;
  const parts = [''], values = [];
  fragments.forEach((item, index) => {
    if (index) { parts.push(''); values.push(separator); }
    values.push(item);
    parts.push('');
  });
  return new SqlFragment(parts, values);
};

/** A table or column name. Only lowercase names of letters, digits and "_". */
sql.ident = name => {
  if (typeof name !== 'string' || !identifier.test(name)) throw new TypeError(`Invalid SQL identifier: ${JSON.stringify(name)}`);
  return new SqlFragment([`"${name}"`], []);
};

/**
 * The current time in milliseconds since 1970, read by the database in the
 * statement that uses it, so a time check commits with its write. The one
 * shared clock expression of all SQL.
 */
export const dbNow = sql`floor(extract(epoch from clock_timestamp())*1000)::bigint`;

/** Text with $n placeholders and the parameter list of a fragment. */
export function compile(root) {
  if (!isSql(root)) throw new TypeError('Pass an sql fragment: sql`...`.');
  const params = [];
  let text = '';
  const walk = item => {
    item.parts.forEach((part, index) => {
      text += part;
      if (index >= item.values.length) return;
      const value = item.values[index];
      if (isSql(value)) walk(value);
      else text += '$' + params.push(value);
    });
  };
  walk(root);
  if (!text.trim()) throw new TypeError('An SQL statement must not be empty.');
  return { text, params };
}

// int8 (also count(*)) as a JS number; outside the safe range it throws.
function int8(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new RangeError(`The database returned ${value}, outside the safe integer range.`);
  return number;
}

const types = {
  bigint: { to: 20, from: [20], serialize: value => String(value), parse: int8 },
  // JSON values stay text, exactly as stored in the text columns.
  json: { to: 114, from: [114, 3802], serialize: value => value, parse: value => value },
};

const localHosts = new Set(['db', 'localhost', '127.0.0.1', '::1', '[::1]']);
const sslModes = new Set(['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full']);

/** Connection settings from a postgres:// URL without credentials (runtime/env.mjs checks the rules). */
export function connectionOptions(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('DATABASE_URL must be a postgres:// URL.'); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error('DATABASE_URL must start with postgres:// or postgresql://.');
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  const sslmode = parsed.searchParams.get('sslmode') ?? (localHosts.has(parsed.hostname) ? 'disable' : 'require');
  // An unknown mode (a typo such as verify_full) fails closed instead of
  // falling back to plaintext: the CLI paths do not run validateDatabaseUrl.
  if (!sslModes.has(sslmode)) throw new Error(`DATABASE_URL has the unknown sslmode ${JSON.stringify(sslmode)}. Use one of: ${[...sslModes].join(', ')}.`);
  const ssl = sslmode === 'disable' ? false
    : sslmode === 'verify-full' ? 'verify-full'
      // verify-ca checks the certificate chain but not the host name.
      : sslmode === 'verify-ca' ? { rejectUnauthorized: true, checkServerIdentity: () => undefined }
        : sslmode === 'require' ? 'require' : 'prefer';
  return {
    host,
    port: Number(parsed.port || 5432),
    database: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
    username: decodeURIComponent(parsed.username),
    ssl,
  };
}

const activeTransaction = new AsyncLocalStorage();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const retryable = error => retryCodes.has(error?.code);

async function withRetry(run) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (!retryable(error) || attempt >= maxAttempts) throw error;
      await delay(retryDelay(attempt));
    }
  }
}

async function run(client, statement) {
  const { text, params } = compile(statement);
  try {
    return await client.unsafe(text, params, { prepare: false });
  } catch (error) {
    // The statement text (never its values) helps to find a failing statement.
    if (error && typeof error === 'object' && !('statement' in error)) Object.defineProperty(error, 'statement', { value: text });
    throw error;
  }
}

function operations(client, guard) {
  return {
    async query(statement) { guard(); return Array.from(await run(client, statement)); },
    async one(statement) { guard(); const rows = await run(client, statement); return rows.length ? rows[0] : null; },
    async exec(statement) { guard(); const result = await run(client, statement); return { rowCount: Number(result.count ?? 0) }; },
  };
}

/**
 * Opens a connection pool. `url` is postgres://user@host:port/database
 * [?sslmode=...] without a password; the password comes separately.
 */
export function createDatabase({ url = process.env.DATABASE_URL, password = process.env.DATABASE_PASSWORD, max = 10, connectTimeoutMs = 3000, idleTimeoutSeconds = 60 } = {}) {
  if (!url) throw new Error('DATABASE_URL is not set.');
  if (!Number.isSafeInteger(max) || max < 1) throw new TypeError('The pool size must be a positive integer.');
  const client = postgres({
    ...connectionOptions(url),
    password: password ?? '',
    max,
    connect_timeout: Math.max(1, Math.ceil(connectTimeoutMs / 1000)),
    idle_timeout: idleTimeoutSeconds,
    prepare: false,
    fetch_types: false,
    onnotice: () => {},
    types,
    connection: { application_name: 'serverdesk', default_transaction_isolation: 'serializable' },
  });
  let closed = false;
  const outside = () => {
    if (closed) throw new Error('The database is closed.');
    if (activeTransaction.getStore()) throw new Error('Inside a transaction, use the tx handle of the callback.');
  };
  const standalone = operations(client, outside);
  const database = {
    query: statement => withRetry(() => standalone.query(statement)),
    one: statement => withRetry(() => standalone.one(statement)),
    exec: statement => withRetry(() => standalone.exec(statement)),
    async transaction(callback, { readOnly = false } = {}) {
      if (typeof callback !== 'function') throw new TypeError('transaction needs a callback.');
      if (activeTransaction.getStore()) throw new Error('A transaction cannot start inside another transaction.');
      outside();
      return withRetry(() => client.begin(readOnly ? 'read only' : '', async raw => {
        let ended = false;
        const tx = operations(raw, () => { if (ended) throw new Error('This transaction has already ended.'); });
        Object.defineProperty(tx, rawHandle, { value: raw });
        try {
          return await activeTransaction.run(tx, () => callback(tx));
        } finally {
          ended = true;
        }
      }));
    },
    async close() {
      if (closed) return;
      closed = true;
      await client.end({ timeout: 5 });
    },
  };
  Object.defineProperty(database, rawHandle, { value: client });
  return database;
}

/**
 * Runs SQL text without parameters, several statements at once. Only the
 * migration runner (scripts/selfhost.mjs) uses it; tests/lib/database-layer.mjs
 * checks that no other file imports it.
 */
export async function runMigrationScript(handle, text) {
  const client = handle?.[rawHandle];
  if (!client) throw new TypeError('runMigrationScript needs a database or transaction handle.');
  if (typeof text !== 'string' || !text.trim()) throw new TypeError('A migration script must not be empty.');
  await client.unsafe(text).simple();
}

const sharedKey = Symbol.for('serverdesk.runtime.database');

/** The pool size from DATABASE_POOL_MAX (default 10). */
export function poolSize(value) {
  if (value === undefined || value === '') return 10;
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 1 || size > 1000) throw new Error('DATABASE_POOL_MAX must be a whole number from 1 to 1000.');
  return size;
}

/**
 * The one pool of this process, shared through globalThis so separate route
 * bundles and module reloads keep a single pool. The fragment and handle keys
 * use Symbol.for so this pool, which outlives a module reload, still accepts
 * fragments and handles from the new module instance. Returns null without
 * DATABASE_URL.
 */
export function sharedDatabase(env = process.env) {
  if (globalThis[sharedKey]) return globalThis[sharedKey];
  if (!env.DATABASE_URL) return null;
  return globalThis[sharedKey] = createDatabase({ url: env.DATABASE_URL, password: env.DATABASE_PASSWORD, max: poolSize(env.DATABASE_POOL_MAX) });
}
