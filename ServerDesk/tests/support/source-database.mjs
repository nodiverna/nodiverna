import { sql, SqlFragment } from '../../runtime/database.mjs';
import { testDatabase } from './postgres.mjs';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { randomUUID } from 'node:crypto';
import { defaultCustomerId, enableMultipleCustomers } from './customer-separation.mjs';

// Each source regression gets its own PostgreSQL database, a copy of the
// migrated template (tests/support/postgres.mjs), with the data layer the
// portal uses. It also becomes this process's shared database, so code that
// calls db() (lib/server/db.ts) reaches the same database. close() drops it.
export async function sourceDatabase() {
  const key = Symbol.for('serverdesk.runtime.database'), previous = globalThis[key];
  const database = await testDatabase(), close = database.close;
  globalThis[key] = database;
  // A second database of the same test hands the shared slot back on close.
  database.close = async () => { if (globalThis[key] === database) globalThis[key] = previous; await close(); };
  return database;
}

// Load real TypeScript dependencies while keeping the test's explicitly chosen
// environment and race-hook boundaries. The cache retains module identity.
const routeModules = new Set(['identity/access-admin', 'identity/account-admin', 'agent/agent-channel', 'devices/terminal-sessions', 'console-data', 'devices/job-records', 'devices/file-jobs', 'agent/heartbeat', 'agent/release-rollout', 'readiness', 'devices/storage-jobs', 'devices/device-history', 'agent/agent-admission', 'devices/device-job-queue'].map(name => `lib/server/${name}.ts`));
export function sourceLoader() {
  const require = createRequire(import.meta.url), cache = new Map();
  function load(file, imports = {}) {
    const absolute = path.resolve(file);
    if (cache.has(absolute)) return cache.get(absolute);
    const fixture = { exports: {} };
    cache.set(absolute, fixture.exports);
    const code = ts.transpileModule(readFileSync(absolute, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    new Function('require', 'exports', 'module', code)(name => {
      if (Object.hasOwn(imports, name)) return imports[name];
      if (name.startsWith('.') || name.startsWith('@/')) {
        const base = name.startsWith('@/') ? path.resolve(name.slice(2)) : path.resolve(path.dirname(absolute), name);
        const target = [base, base + '.ts', base + '.mts', path.join(base, 'index.ts')].find(candidate => existsSync(candidate));
        if (!target) throw new Error(`Missing source fixture dependency: ${name} from ${file}`);
        // A route stub given as '@/lib/x' also replaces the relative import of the
        // same file in the domain modules that hold the former route code.
        const alias = '@/' + path.relative(path.resolve('.'), target).split(path.sep).join('/').replace(/[.](?:ts|mts|tsx)$/, '').replace(/[/]index$/, '');
        if (routeModules.has(path.relative(path.resolve('.'), absolute).split(path.sep).join('/')) && Object.hasOwn(imports, alias)) return imports[alias];
        return /\.(?:ts|mts)$/.test(target) ? load(target, imports) : require(target);
      }
      if (name === 'cloudflare:workers') return require('../../runtime/env.mjs');
      return require(name);
    }, fixture.exports, fixture);
    cache.set(absolute, fixture.exports);
    return fixture.exports;
  }
  return load;
}

// lib/server/db.ts for test loaders that map './db' themselves.
let dbModuleCache;
export function dbModule() { return dbModuleCache ??= sourceLoader()('lib/server/db.ts'); }

// Failure injection: a PL/pgSQL row trigger `name` on `table` (timing and
// event such as 'BEFORE UPDATE') that runs `body`, by default RAISE EXCEPTION
// with `message`. DDL takes no parameters, so names and the message are checked
// and written as text. dropTrigger removes the trigger and its function.
const triggerTables = new Map();
const plain = /^[A-Za-z0-9_ :.-]*$/;
export async function createTrigger(database, name, table, timing, { message = 'boom', body, when } = {}) {
  if (!/^[a-z_][a-z0-9_]*$/.test(name) || !/^[a-z_][a-z0-9_]*$/.test(table) || !/^(BEFORE|AFTER) (INSERT|UPDATE|DELETE)( OF [a-z_, ]+)?$/.test(timing) || !plain.test(message)) throw new Error('Invalid test trigger.');
  const statement = body ?? `RAISE EXCEPTION '${message}';`;
  await database.exec(new SqlFragment([`CREATE FUNCTION ${name}_fn() RETURNS trigger LANGUAGE plpgsql AS $test$BEGIN ${statement} RETURN COALESCE(NEW, OLD); END$test$`], []));
  await database.exec(new SqlFragment([`CREATE TRIGGER ${name} ${timing} ON ${table} FOR EACH ROW${when ? ` WHEN (${when})` : ''} EXECUTE FUNCTION ${name}_fn()`], []));
  triggerTables.set(name, table);
}
export async function dropTrigger(database, name, table = triggerTables.get(name)) {
  if (!/^[a-z_][a-z0-9_]*$/.test(name) || !/^[a-z_][a-z0-9_]*$/.test(table ?? '')) throw new Error('Invalid test trigger.');
  await database.exec(new SqlFragment([`DROP TRIGGER IF EXISTS ${name} ON ${table}`], []));
  await database.exec(new SqlFragment([`DROP FUNCTION IF EXISTS ${name}_fn()`], []));
  triggerTables.delete(name);
}

// A list of column names (array or comma-separated text) as identifiers.
export const idents = list => sql.join(String(list).split(',').map(name => sql.ident(name.trim())));

// One fixture row: column names from the object keys, values as parameters.
// A customer other than the default customer turns the setting "Multiple
// customers" on first (enableMultipleCustomers): its insert trigger refuses the
// row while the setting is off.
export async function insertRow(database, table, row) {
  const columns = Object.keys(row);
  if (table === 'customers' && row.id !== defaultCustomerId) await database.exec(enableMultipleCustomers());
  return database.exec(sql`INSERT INTO ${sql.ident(table)}(${sql.join(columns.map(column => sql.ident(column)))}) VALUES(${sql.join(columns.map(column => sql`${row[column]}`))})`);
}

// Fixture statements in one transaction, in order; the rows of each.
export async function inTransaction(database, statements) {
  return database.transaction(async tx => {
    const results = [];
    for (const statement of statements) results.push(await tx.query(statement));
    return results;
  });
}

// Race tests mutate the current local-user and RBAC records. The actor carries
// the version stamp of its account (auth_version 1), so every write guard checks
// the live account; a global '*' role also gives '*' in the client permissions.
export async function sourceActor(database, label, permissions = [], scopeType = 'global', scopeId = '*') {
  const id = randomUUID(), roleId = randomUUID(), assignmentId = randomUUID(), at = Date.now();
  const owner = scopeType === 'global' && permissions.includes('*');
  const actor = { id, label, principal: 'local:' + id, permissions: owner ? ['*'] : [], authorization: { authVersion: 1 } };
  await database.transaction(async tx => {
    await tx.exec(sql`INSERT INTO local_users(id,username,email,display_name,auth_principal,auth_email,status,auth_version,created_at,updated_at) VALUES(${id},${id},${label},${label},${actor.principal},${label},'active',1,${at},${at})`);
    await tx.exec(sql`INSERT INTO rbac_roles(id,name,description,permissions,builtin,created_at) VALUES(${roleId},${'Source role ' + id},'Source race fixture',${JSON.stringify(permissions)},0,${at})`);
    await tx.exec(sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) VALUES(${assignmentId},'user',${id},${roleId},${scopeType},${scopeId},${at},${actor.principal})`);
  });
  return { actor, roleId, assignmentId };
}

// Schema reads for the shape checks of the tests, from the PostgreSQL catalog.
// tableColumns: {name, type (format_type, such as 'text' or 'bigint'), notnull
// (0/1), dflt_value (the default expression without a '::text' cast), pk (the
// 1-based position in the primary key, 0 outside it)} per column in order.
export async function tableColumns(database, table) {
  const rows = await database.query(sql`SELECT a.attname AS name,pg_catalog.format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS notnull,
    pg_catalog.pg_get_expr(d.adbin,d.adrelid) AS dflt_value,coalesce(array_position(p.conkey,a.attnum),0) AS pk
    FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    LEFT JOIN pg_catalog.pg_constraint p ON p.conrelid=a.attrelid AND p.contype='p'
    WHERE a.attrelid=to_regclass(${'public.' + table}) AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`);
  return rows.map(row => ({ ...row, notnull: row.notnull ? 1 : 0, dflt_value: row.dflt_value === null ? null : row.dflt_value.replace(/::text$/, '') }));
}
// tableIndexes: {name, unique (0/1), columns} per index of the table, by name.
export async function tableIndexes(database, table) {
  const rows = await database.query(sql`SELECT i.relname AS name,x.indisunique AS unique,
    (SELECT json_agg(pg_catalog.pg_get_indexdef(x.indexrelid,k,true) ORDER BY k)::text FROM generate_series(1,x.indnkeyatts) AS k) AS columns
    FROM pg_catalog.pg_index x JOIN pg_catalog.pg_class i ON i.oid=x.indexrelid WHERE x.indrelid=to_regclass(${'public.' + table}) ORDER BY i.relname`);
  return rows.map(row => ({ name: row.name, unique: row.unique ? 1 : 0, columns: JSON.parse(row.columns) }));
}
// The key columns (or expressions) of one index, in order; [] for an unknown index.
export async function indexColumns(database, index) {
  const row = await database.one(sql`SELECT (SELECT json_agg(pg_catalog.pg_get_indexdef(x.indexrelid,k,true) ORDER BY k)::text FROM generate_series(1,x.indnkeyatts) AS k) AS columns
    FROM pg_catalog.pg_index x WHERE x.indexrelid=to_regclass(${'public.' + index})`);
  return row ? JSON.parse(row.columns) : [];
}
