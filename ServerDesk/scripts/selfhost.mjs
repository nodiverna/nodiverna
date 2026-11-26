#!/usr/bin/env node
/**
 * Offline administration; never expose this script through an HTTP route.
 *
 *   node --env-file=.env.local scripts/selfhost.mjs migrate [--skip-backup]
 *   node --env-file=.env.local scripts/selfhost.mjs bootstrap-owner \
 *     --username admin --display-name "Administrator" --email admin@example.com
 *   node --env-file=.env.local scripts/selfhost.mjs maintenance [--audit-days 30] [--job-days 30] [--software-days 365] [--alert-days 90]
 *   node --env-file=.env.local scripts/selfhost.mjs rewrap-secrets
 *   node --env-file=.env.local scripts/selfhost.mjs reset-totp --confirm
 *   node --env-file=.env.local scripts/selfhost.mjs import-release <dir>
 *   node --env-file=.env.local scripts/selfhost.mjs backup [--output <file>]
 *   node --env-file=.env.local scripts/selfhost.mjs restore --input <file> [--replace]
 *
 * DATABASE_URL is the PostgreSQL URL without a password
 * (postgres://serverdesk@db:5432/serverdesk); the password is in
 * DATABASE_PASSWORD. Bootstrap requires SITE_ORIGIN, SESSION_SECRET and
 * PASSWORD_PEPPER. Its JSON output contains the only copy of a personal,
 * single-use invitation URL (valid for 24 hours). Set the password and enroll
 * MFA in the browser; passwords never enter this CLI.
 *
 * The portal runs maintenance itself every day (runtime/maintenance.mjs,
 * page Settings → Maintenance). The command maintenance runs it once, as a tool
 * for support and tests. It applies the instance audit/job retention of the
 * maintenance page (flag, then stored setting, then AUDIT_RETENTION_DAYS and
 * JOB_RETENTION_DAYS, then 30 days) and clears expired file transfers of every
 * device. A customer with its own audit retention (customers.audit_retention_days,
 * set on the page "Customers") keeps its device rows and customer entries for
 * exactly that many days; the customer value wins over the instance retention.
 * The software change history of the devices is kept for
 * SOFTWARE_CHANGE_RETENTION_DAYS (--software-days, default 365; no stored
 * setting), closed alarms for ALERT_RETENTION_DAYS (--alert-days, default 90;
 * no stored setting either). It takes the same lock as the portal: while another run holds it, the
 * command exits with 1 and writes nothing.
 *
 * Maintenance also has the daily usage report (docs/usage-data.md). This
 * version sends no usage report: the function is off (usageDataEnabled in
 * runtime/usage-report.mjs) and the output is "usageReport":{"status":"disabled"}.
 * Once turned on, it sends instance id, version and device count, at most once
 * in 20 hours, only after an Owner agreed in the portal and only to
 * LICENSE_SERVER_URL. The report never changes the exit code. Then it checks GitHub once for new agent
 * releases (runtime/release-import.mjs, "releaseImport" in the output); the
 * check only adds catalog entries and never changes the exit code either.
 *
 * rewrap-secrets finishes a SESSION_SECRET change (docs/self-hosting.md,
 * "Change the session secret"): it encrypts every stored TOTP secret, every
 * notification channel secret, the NVD API key and the provider keys of the
 * device assistant again with the current SESSION_SECRET. Values under a secret listed in
 * SESSION_SECRET_PREVIOUS are decrypted and written back with a
 * compare-and-swap update, row by row, so the portal can stay online; a
 * request that races with the change of its row fails once. The JSON output
 * has only the kid and counters. With failed > 0 the exit code is 1: an old
 * secret is missing in SESSION_SECRET_PREVIOUS, or a value is not in the
 * keyring format. A second run rewraps nothing. Each run that checked every
 * value writes one portal audit row (actor System, action "Secrets rewrapped")
 * with the kid and the counters, also with failed > 0.
 *
 * reset-totp --confirm deletes every stored TOTP secret: all authenticator
 * apps and pending app setups. Use it after SESSION_SECRET leaked together
 * with a copy of the database. An affected account with a passkey keeps MFA as
 * a passkey-only account with its recovery codes; an affected account without
 * a passkey loses its MFA account and enrolls again at the next sign-in. The
 * MFA sessions, remembered browsers and proofs of every affected account end.
 * All of this, and one audit row (actor System, action "TOTP authenticators
 * reset") with the counters, commit in one transaction. The JSON output has
 * only counters. Without --confirm it changes nothing and exits with 1.
 *
 * import-release <dir> imports one agent release folder without network access
 * (docs/self-hosting.md, "Agent releases from GitHub"), for an installation
 * without access to GitHub: exactly one ServerDesk-Agent-X.Y.Z-release.json
 * and its four sibling files (ZIP, EXE, manifest and signature, as on the
 * GitHub release). It applies the same checks as the import from GitHub
 * (the pinned publisher key, every SHA-256, version and path conflicts),
 * stores the files in the object storage (OBJECT_STORAGE_DRIVER) and adds the
 * release to the catalog with one audit row (actor System, action "Agent
 * release imported from a folder"). It never updates a device. The JSON output
 * is {version, releaseId, status}; a missing file or a failed check exits with 1.
 * A plugin release folder (docs/agent-plugins.md) holds exactly one
 * ServerDesk-Plugin-<name>-X.Y.Z-release.json and its three sibling files
 * (EXE, manifest and signature); its audit row is "Plugin release imported
 * from a folder" and the output adds kind plugin and the name.
 *
 * Only maintenance writes maintenance_runs: every maintenance run records a
 * row (start, end, status, trigger, result JSON or error); Owners see a console notice
 * when the last successful run is older than 48 hours. bootstrap-owner,
 * rewrap-secrets and reset-totp write an audit row instead.
 *
 * Migrations commit their SQL and checksum journal in the same transaction. A
 * PostgreSQL advisory lock serializes concurrent runs, so each migration is
 * applied exactly once. The checksum is the SHA-256 of the file with LF line
 * endings, so a Windows checkout with CRLF and a Linux checkout journal the
 * same value. A journal row with any other checksum, the one of the CRLF bytes
 * included, is a changed migration and stops migrate. A database with a schema
 * but without a journal is refused; this command never guesses which
 * migrations it already contains.
 *
 * Before the first pending migration on a database that already has applied
 * migrations, migrate writes a pg_dump backup (custom format) to
 * <BACKUP_DIRECTORY>/serverdesk-pre-<migration>-<UTC time>.dump and its
 * .sha256 file. It never overwrites a file. If the backup fails, no migration
 * runs. --skip-backup skips it with a notice (for example on Azure, which has
 * its own point-in-time restore). backup and restore use pg_dump and
 * pg_restore from PG_BIN_DIR or PATH; their major version must match the
 * server. The password reaches them only through PGPASSWORD in their
 * environment. drizzle/schema.lock.sql holds the schema after all migrations;
 * pnpm db:schema-lock rewrites it, and a test compares both.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectionOptions, runMigrationScript, sql } from '../runtime/database.mjs';
import { secretsRewrapAuditAction, totpResetAuditAction } from '../runtime/audit-actions.mjs';
import { authenticatorManaged, encryptedColumns } from '../runtime/previous-secret.mjs';
import { createKeyring, decryptWithKeyring, encryptWithKeyring, needsRewrap } from '../runtime/secret-keyring.mjs';
import { importReleaseFolder } from '../runtime/release-import.mjs';
import {
  maintenanceLockHeldMessage, maintenanceMigrationsMessage, migrationsPending, readMaintenanceSettings, resolveRetention, startMaintenance,
} from '../runtime/maintenance.mjs';

// The maintenance logic lives in runtime/maintenance.mjs; tests and tools import these names from here.
export {
  maintenanceSelections, maintenanceTransferStates, recordMaintenanceRun, resolveRetention, retentionDays, runMaintenance, transferFailureMessage,
} from '../runtime/maintenance.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const migrationDirectory = path.join(projectRoot, 'drizzle');
const journalTable = '_serverdesk_migrations';
const journal = sql.ident(journalTable);
const migrationLock = sql`hashtext('serverdesk:migrate')`;
const schemaLockHeader = '-- ServerDesk schema after all migrations. Generated by pnpm db:schema-lock; do not edit by hand.';
const schemaLockTypes = ['table', 'index', 'view', 'function', 'trigger'];
const bootstrapMarker = 'selfhost_bootstrap_v1';
const ownerRole = {
  id: 'builtin-owner',
  name: 'Owner',
  description: 'Vollständiger Portal- und Gerätezugriff im zugewiesenen Geltungsbereich.',
  permissions: '["*"]',
};

async function migrationFiles(directory) {
  const names = (await readdir(directory)).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort();
  if (!names.length) throw new Error('No schema migrations found.');
  if (new Set(names.map(name => name.slice(0, 4))).size !== names.length) {
    throw new Error('Two or more migrations have the same number.');
  }
  return Promise.all(names.map(async name => {
    // latin1 maps every byte to one character, so only line endings change.
    const lfBytes = (await readFile(path.join(directory, name))).toString('latin1').replaceAll('\r\n', '\n');
    const script = Buffer.from(lfBytes, 'latin1').toString('utf8');
    if (!script.replace(/--[^\n]*/g, '').trim()) throw new Error(`The migration ${name} contains no SQL statements.`);
    return { name, checksum: sha256(lfBytes), script };
  }));
}

function sha256(bytes) {
  return createHash('sha256').update(bytes, 'latin1').digest('hex');
}

async function journalExists(database) {
  return !!await database.one(sql`SELECT 1 AS present FROM pg_catalog.pg_tables WHERE schemaname='public' AND tablename=${journalTable}`);
}

/** The applied migrations, checked against the source; null without a journal. */
async function migrationState(database, files) {
  if (!await journalExists(database)) return null;
  const applied = await database.query(sql`SELECT name,checksum FROM ${journal} ORDER BY name`);
  for (let index = 0; index < applied.length; index++) {
    const entry = applied[index], source = files[index];
    if (!source || entry.name !== source.name) {
      throw new Error(`The migration journal does not match the source (${entry.name}). Check for missing or skipped migrations first.`);
    }
    if (entry.checksum !== source.checksum) {
      throw new Error(`The applied migration ${entry.name} was changed. The database stays unchanged. Create a new migration instead.`);
    }
  }
  return applied;
}

/** Tables, views, sequences and functions in the schema public, the journal excluded. */
async function publicObjects(database) {
  return (await database.query(sql`SELECT c.relname AS name FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S','f') AND c.relname<>${journalTable}
    UNION ALL SELECT p.proname FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'`)).map(row => row.name);
}

const noJournalMessage = 'This database contains a schema without a complete ServerDesk migration journal. Nothing is adopted or overwritten automatically. Check the database import first.';

/** UTC time as yyyymmddThhmmssZ. */
const fileTime = (date = new Date()) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

/**
 * Apply the SQL migrations in drizzle/. Each one and its journal row commit in
 * one transaction under an advisory lock. With `backup` ({url, password,
 * directory, skip, pgBinDir}) a database that already has applied migrations
 * gets a pg_dump backup before the first pending one; without it nothing is
 * backed up (tests, template databases).
 */
export async function migrateDatabase(database, { directory = migrationDirectory, backup, notice = () => {}, clock = () => new Date() } = {}) {
  const files = await migrationFiles(directory);
  const before = await migrationState(database, files);
  if (!before?.length && (await publicObjects(database)).length) throw new Error(noJournalMessage);
  const pending = files.slice(before?.length ?? 0);
  let backupFile;
  if (pending.length && before?.length && backup) {
    if (backup.skip) {
      notice('migrate runs without a backup (--skip-backup). Make sure that you have a current backup of the database.');
    } else {
      const target = await uniqueFile(path.join(backup.directory, `serverdesk-pre-${pending[0].name.replace(/\.sql$/, '')}-${fileTime(clock())}`), '.dump');
      try {
        // backup.dump replaces pg_dump in tests; it gets the same arguments as dumpDatabase.
        backupFile = (await (backup.dump ?? dumpDatabase)(database, { ...backup, file: target })).file;
      } catch (error) {
        const reason = String(error instanceof Error ? error.message : error).replace(/[.\s]+$/, '');
        throw new Error(`The backup before the migration ${pending[0].name} failed: ${reason}. No migration was applied. Check the free space and the write permission in ${backup.directory}, and that pg_dump has the major version of the server (PG_BIN_DIR).`, { cause: error });
      }
      notice(`Backup before migration ${pending[0].name} created: ${backupFile}`);
    }
  }
  let applied = 0;
  for (const migration of pending) {
    const done = await database.transaction(async tx => {
      // READ COMMITTED inside the lock: every statement sees the commits of a
      // concurrent run that held the lock before.
      await tx.exec(sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`);
      await tx.one(sql`SELECT pg_advisory_xact_lock(${migrationLock}) AS locked`);
      if (!await journalExists(tx)) {
        if ((await publicObjects(tx)).length) throw new Error(noJournalMessage);
        await tx.exec(sql`CREATE TABLE ${journal} (name text PRIMARY KEY NOT NULL, checksum text NOT NULL, applied_at bigint NOT NULL)`);
      }
      const state = await migrationState(tx, files);
      if (state.some(entry => entry.name === migration.name)) return false;
      await runMigrationScript(tx, migration.script);
      await tx.exec(sql`INSERT INTO ${journal}(name,checksum,applied_at) VALUES(${migration.name},${migration.checksum},${Date.now()})`);
      return true;
    });
    if (done) applied++;
  }
  return { applied, total: files.length, ...(backupFile ? { backup: backupFile } : {}) };
}

/** A file name that does not exist yet: base.ext, base-2.ext, base-3.ext, ... */
async function uniqueFile(base, extension) {
  let target = base + extension;
  for (let number = 2; existsSync(target) || existsSync(target + '.sha256'); number++) target = `${base}-${number}${extension}`;
  return target;
}

const quoteIdent = name => '"' + String(name).replaceAll('"', '""') + '"';

/** The objects of drizzle/schema.lock.sql, ordered by type (table, index, view, function, trigger), then by binary name. */
export async function schemaLockObjects(database) {
  const objects = [];
  const tables = await database.query(sql`SELECT c.oid::bigint AS oid,c.relname AS name FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r' AND c.relname<>${journalTable}`);
  for (const table of tables) {
    const columns = await database.query(sql`SELECT a.attname AS name,pg_catalog.format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS not_null,
      pg_catalog.pg_get_expr(d.adbin,d.adrelid) AS default_value,a.attidentity AS identity
      FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid=${table.oid}::oid AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`);
    const constraints = await database.query(sql`SELECT conname AS name,pg_catalog.pg_get_constraintdef(oid) AS definition FROM pg_catalog.pg_constraint WHERE conrelid=${table.oid}::oid AND contype<>'n'`);
    const lines = columns.map(column => ` ${quoteIdent(column.name)} ${column.type}${column.identity === 'd' ? ' GENERATED BY DEFAULT AS IDENTITY' : column.identity === 'a' ? ' GENERATED ALWAYS AS IDENTITY' : ''}${column.default_value !== null ? ' DEFAULT ' + column.default_value : ''}${column.not_null ? ' NOT NULL' : ''}`);
    for (const constraint of constraints.sort((a, b) => compareText(a.name, b.name))) lines.push(` CONSTRAINT ${quoteIdent(constraint.name)} ${constraint.definition}`);
    objects.push({ type: 'table', name: table.name, sql: `CREATE TABLE ${quoteIdent(table.name)} (\n${lines.join(',\n')}\n)` });
  }
  const indexes = await database.query(sql`SELECT i.relname AS name,pg_catalog.pg_get_indexdef(x.indexrelid) AS definition FROM pg_catalog.pg_index x
    JOIN pg_catalog.pg_class i ON i.oid=x.indexrelid JOIN pg_catalog.pg_class t ON t.oid=x.indrelid JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='public' AND t.relname<>${journalTable} AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conindid=x.indexrelid)`);
  for (const index of indexes) objects.push({ type: 'index', name: index.name, sql: index.definition });
  const views = await database.query(sql`SELECT c.relname AS name,pg_catalog.pg_get_viewdef(c.oid,true) AS definition FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='v'`);
  for (const view of views) objects.push({ type: 'view', name: view.name, sql: `CREATE VIEW ${quoteIdent(view.name)} AS\n${view.definition.replace(/;\s*$/, '')}` });
  const functions = await database.query(sql`SELECT p.proname AS name,pg_catalog.pg_get_functiondef(p.oid) AS definition FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f'`);
  for (const fn of functions) objects.push({ type: 'function', name: fn.name, sql: fn.definition.trimEnd() });
  const triggers = await database.query(sql`SELECT t.tgname AS name,pg_catalog.pg_get_triggerdef(t.oid) AS definition FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal`);
  for (const trigger of triggers) objects.push({ type: 'trigger', name: trigger.name, sql: trigger.definition });
  return objects
    .map(object => ({ ...object, sql: object.sql.replaceAll('\r\n', '\n') }))
    .sort((a, b) => schemaLockTypes.indexOf(a.type) - schemaLockTypes.indexOf(b.type) || compareText(a.name, b.name));
}

const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The text of drizzle/schema.lock.sql: the header, then each object as "<sql>;", separated by a blank line, LF only. */
export async function schemaLock(database) {
  const objects = await schemaLockObjects(database);
  // A carriage return inside a definition (the btrim CHECKs) is written as \r,
  // so the lock stays a plain LF text file.
  return [schemaLockHeader, ...objects.map(object => `${object.sql.replaceAll('\r', '\\r')};`)].join('\n\n') + '\n';
}

// pg_dump and pg_restore. The connection reaches them only through the PG*
// environment variables, so the password never appears in arguments or output.
function toolEnvironment({ url, password }) {
  const options = connectionOptions(url);
  const parsed = new URL(url);
  const environment = { ...process.env, PGHOST: options.host, PGPORT: String(options.port), PGUSER: options.username, PGDATABASE: options.database, PGCONNECT_TIMEOUT: '10' };
  environment.PGSSLMODE = parsed.searchParams.get('sslmode') ?? (options.ssl ? 'require' : 'disable');
  if (password) environment.PGPASSWORD = password;
  else delete environment.PGPASSWORD;
  return environment;
}

function toolPath(tool, pgBinDir = process.env.PG_BIN_DIR) {
  const file = process.platform === 'win32' ? `${tool}.exe` : tool;
  return pgBinDir ? path.join(pgBinDir, file) : file;
}

function runTool(command, args, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    const collect = chunk => { output = (output + chunk).slice(-16_384); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', error => reject(error.code === 'ENOENT' ? new Error(`${path.basename(command)} was not found. Install the PostgreSQL 17 client tools or set PG_BIN_DIR`) : error));
    child.on('close', code => resolve({ code, output: output.trim() }));
  });
}

async function checkToolVersion(database, tool, pgBinDir) {
  const command = toolPath(tool, pgBinDir);
  const { code, output } = await runTool(command, ['--version'], process.env);
  const toolMajor = Number(/\(PostgreSQL\)\s+(\d+)/.exec(output)?.[1] ?? /\s(\d+)(?:\.\d+)*\s*$/.exec(output)?.[1]);
  if (code !== 0 || !Number.isInteger(toolMajor)) throw new Error(`${tool} did not report its version (${output || 'exit code ' + code})`);
  const { major } = await database.one(sql`SELECT (current_setting('server_version_num')::int / 10000) AS major`);
  if (toolMajor !== major) throw new Error(`${tool} has the major version ${toolMajor}, but the server runs PostgreSQL ${major}. Use the client tools of version ${major} (PG_BIN_DIR)`);
  return command;
}

async function fileSha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

const tail = text => text.split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 500);

/**
 * Writes a custom-format pg_dump of the database to `file` and `<file>.sha256`.
 * Refuses an existing file. Returns {file, sha256, bytes}.
 */
export async function dumpDatabase(database, { url, password, file, pgBinDir }) {
  if (existsSync(file) || existsSync(file + '.sha256')) throw new Error(`The file ${file} already exists. Choose another file name`);
  const command = await checkToolVersion(database, 'pg_dump', pgBinDir);
  // The dump holds password hashes, encrypted MFA secrets and token hashes:
  // a new backup directory is 0700, and the dump is created empty with 0600
  // before pg_dump writes into it (pg_dump keeps the mode of an existing file).
  await mkdir(path.dirname(path.resolve(file)), { recursive: true, mode: 0o700 });
  await writeFile(file, '', { flag: 'wx', mode: 0o600 });
  const { code, output } = await runTool(command, ['--format=custom', '--no-password', `--file=${file}`], toolEnvironment({ url, password }));
  if (code !== 0) {
    await rm(file, { force: true });
    throw new Error(`pg_dump failed${output ? ': ' + tail(output) : ''}`);
  }
  const digest = await fileSha256(file);
  await writeFile(file + '.sha256', `${digest}  ${path.basename(file)}\n`, { flag: 'wx', mode: 0o600 });
  return { file, sha256: digest, bytes: (await stat(file)).size };
}

/**
 * Restores a dump made by dumpDatabase. Refuses a dump whose .sha256 does not
 * match, and a database with tables in public unless `replace` is set. Returns
 * the applied and pending migrations from the journal.
 */
export async function restoreDatabase(database, { url, password, file, replace = false, pgBinDir, directory = migrationDirectory }) {
  const expected = (await readFile(file + '.sha256', 'utf8').catch(() => { throw new Error(`The checksum file ${file}.sha256 is missing. The dump was not restored`); })).trim().split(/\s+/)[0];
  if (!/^[0-9a-f]{64}$/.test(expected) || expected !== await fileSha256(file)) throw new Error(`The dump ${file} does not match its checksum file. The dump was not restored`);
  const tables = await database.query(sql`SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname='public'`);
  if (tables.length && !replace) throw new Error('The database already contains tables. Restore into an empty database, or add --replace to replace its contents');
  const command = await checkToolVersion(database, 'pg_restore', pgBinDir);
  const args = ['--single-transaction', '--exit-on-error', '--no-owner', '--no-privileges', '--no-password', ...(replace ? ['--clean', '--if-exists'] : []), `--dbname=${connectionOptions(url).database}`, file];
  const { code, output } = await runTool(command, args, toolEnvironment({ url, password }));
  if (code !== 0) throw new Error(`pg_restore failed${output ? ': ' + tail(output) : ''}. The database stays unchanged`);
  const files = await migrationFiles(directory);
  const applied = await journalExists(database) ? (await database.query(sql`SELECT name FROM ${journal} ORDER BY name`)).map(row => row.name) : [];
  return { file, applied, pending: files.map(entry => entry.name).filter(name => !applied.includes(name)) };
}

function bootstrapConfiguration(env, suppliedOrigin) {
  for (const key of ['SESSION_SECRET', 'PASSWORD_PEPPER']) {
    if (typeof env[key] !== 'string' || Buffer.byteLength(env[key], 'utf8') < 32) {
      throw new Error(`${key} must contain an externally managed secret with at least 32 UTF-8 bytes.`);
    }
  }
  const value = suppliedOrigin ?? env.SITE_ORIGIN;
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('SITE_ORIGIN must contain a complete HTTPS origin.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.origin !== value || parsed.username || parsed.password || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local))) {
    throw new Error('SITE_ORIGIN must be exactly the HTTPS origin, without a trailing slash or path. HTTP is allowed only on localhost.');
  }
  return parsed.origin;
}

/**
 * Create the first invited global Owner in one guarded transaction.
 * This deliberately refuses every existing local account, including an expired
 * initial invitation. Existing installations use authenticated administration
 * or a separately reviewed recovery procedure instead of rerunning bootstrap.
 */
export async function bootstrapOwner(database, {
  username,
  displayName,
  email = '',
  origin,
  env = process.env,
  directory = migrationDirectory,
} = {}) {
  const siteOrigin = bootstrapConfiguration(env, origin);
  const name = typeof username === 'string' ? username.trim().toLowerCase() : '';
  if (!/^[a-z0-9][a-z0-9._@+-]{2,63}$/.test(name)) {
    throw new Error('Username: use 3 to 64 characters from letters, digits and . _ @ + -');
  }
  const label = typeof displayName === 'string' ? displayName.trim() : '';
  if (!label || label.length > 120 || /[\u0000-\u001f\u007f]/.test(label)) {
    throw new Error('Enter a display name with 1 to 120 characters.');
  }
  if (typeof email !== 'string' || (email !== '' && (email.length > 254 || !/^\S+@\S+\.\S+$/.test(email) || /[\u0000- \u007f]/.test(email)))) {
    throw new Error('Enter a valid email address or leave out --email.');
  }
  const files = await migrationFiles(directory), applied = await migrationState(database, files);
  if (!applied || applied.length !== files.length) throw new Error('Apply all migrations with the command migrate before bootstrap-owner.');
  if (await database.one(sql`SELECT id FROM local_users LIMIT 1`)) {
    throw new Error('Local users already exist. bootstrap-owner cannot adopt or change existing accounts.');
  }
  if (await database.one(sql`SELECT value FROM identity_settings WHERE key=${bootstrapMarker}`)) {
    throw new Error('The initial Owner is already set up. You can use bootstrap-owner only once.');
  }
  const existingRole = await database.one(sql`SELECT name,permissions,builtin FROM rbac_roles WHERE id=${ownerRole.id}`);
  if (existingRole && (existingRole.name !== ownerRole.name || existingRole.permissions !== ownerRole.permissions || existingRole.builtin !== 1)) {
    throw new Error('The existing Owner role differs from the built-in role model. Check it before the initialization.');
  }

  const userId = randomUUID(), authEmail = `${userId}@local.serverdesk.invalid`, token = randomBytes(32).toString('hex');
  const digest = createHash('sha256').update(token).digest('hex'), at = Date.now(), expiresAt = at + 24 * 60 * 60_000;
  // Each statement commits only while this run owns the bootstrap marker.
  const guard = sql`EXISTS(SELECT 1 FROM identity_settings WHERE key=${bootstrapMarker} AND value=${userId})`;
  const created = await database.transaction(async tx => {
    const marker = await tx.exec(sql`INSERT INTO identity_settings(key,value) SELECT ${bootstrapMarker}::text,${userId}::text WHERE NOT EXISTS(SELECT 1 FROM local_users) ON CONFLICT(key) DO NOTHING`);
    await tx.exec(sql`INSERT INTO rbac_roles(id,name,description,permissions,builtin,created_at) SELECT ${ownerRole.id}::text,${ownerRole.name}::text,${ownerRole.description}::text,${ownerRole.permissions}::text,1,${at}::bigint WHERE ${guard} ON CONFLICT(id) DO NOTHING`);
    const user = await tx.exec(sql`INSERT INTO local_users(id,username,email,display_name,auth_principal,auth_email,status,password_hash,auth_version,must_reset,created_at,updated_at) SELECT ${userId}::text,${name}::text,${email.toLowerCase()}::text,${label}::text,${'private:' + authEmail}::text,${authEmail}::text,'invited',NULL,1,0,${at}::bigint,${at}::bigint WHERE ${guard}`);
    await tx.exec(sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) SELECT ${randomUUID()}::text,'user',${userId}::text,'builtin-owner','global','*',${at}::bigint,'offline-bootstrap' WHERE ${guard}`);
    const invitation = await tx.exec(sql`INSERT INTO local_account_tokens(token_hash,user_id,kind,created_at,expires_at,auth_version) SELECT ${digest}::text,${userId}::text,'invite',${at}::bigint,${expiresAt}::bigint,1 WHERE ${guard}`);
    // The portal seeds the other built-in roles on the first request (lib/server/identity/rbac.ts).
    await tx.exec(sql`INSERT INTO audit(at,actor,action,target) SELECT ${at}::bigint,'offline-bootstrap','auth.owner.bootstrap',${userId}::text WHERE ${guard}`);
    return marker.rowCount === 1 && user.rowCount === 1 && invitation.rowCount === 1;
  });
  if (!created) {
    throw new Error('Another process already set up the initial Owner. No further invitation was created.');
  }
  return { userId, username: name, invitationUrl: siteOrigin + '/#invite=' + token, expiresAt };
}

function parseFlags(args, allowed, switches = []) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (switches.includes(flag) && options[flag] === undefined) { options[flag] = true; continue; }
    if (!allowed.includes(flag) || options[flag] !== undefined || !args[index + 1] || args[index + 1].startsWith('--')) {
      throw new Error(`Invalid or incomplete argument: ${flag}`);
    }
    options[flag] = args[++index];
  }
  return options;
}

function parseArguments(args) {
  const options = parseFlags(args, ['--username', '--display-name', '--email']);
  return { username: options['--username'], displayName: options['--display-name'], email: options['--email'] ?? '' };
}

/**
 * The support tool for one maintenance run (the portal runs maintenance itself
 * every day, runtime/maintenance-scheduler.mjs). It takes the same lock as the
 * portal and writes trigger 'cli'. The retention per value: flag, stored
 * setting, environment variable, 30 days. A held lock exits with 1 and writes
 * no row.
 */
async function maintenance(database, flags) {
  if (await migrationsPending(database)) throw new Error(maintenanceMigrationsMessage);
  // Without a flag or a stored value an invalid variable stops the run before it starts.
  const retention = resolveRetention({ args: flags, env: process.env, stored: await readMaintenanceSettings(database) });
  const { createStorage } = await import('../runtime/storage.mjs');
  const started = await startMaintenance(database, {
    trigger: 'cli', retention, storage: createStorage(process.env), env: process.env,
    notice: message => console.error('ServerDesk: ' + message),
  });
  if (started.status === 'migrations-pending') throw new Error(maintenanceMigrationsMessage);
  if (started.status !== 'started') throw new Error(maintenanceLockHeldMessage);
  const outcome = await started.finished;
  if (outcome.error) throw outcome.error;
  if (outcome.result.transfers.failed > 0) process.exitCode = 1;
  return outcome.result;
}

/** The stderr text (without "ServerDesk: ") of a rewrap run with values it could not decrypt. */
export const rewrapFailureMessage = failed => `${failed} encrypted values could not be decrypted. Add the old secret to SESSION_SECRET_PREVIOUS and run rewrap-secrets again.`;

/**
 * Encrypts every stored TOTP secret and every notification channel secret
 * (notification_channels.secret, context notification-channel:<id>) and the
 * NVD API key (vulnerability_settings.api_key) and the provider keys of the device
 * assistant (assistant_keys.secret) again with the current SESSION_SECRET.
 * Refuses before it reads a secret when the keyring cannot be built or a
 * migration is missing. A value that does not decrypt stays unchanged and
 * counts as failed; a compare-and-swap miss (the portal changed the row in the
 * meantime) counts as unchanged. The result never holds a secret, a plaintext
 * or a ciphertext. After the last value it writes one portal audit row with
 * the kid and the counters, also when values failed.
 */
export async function rewrapSecrets(database, { env = process.env, directory = migrationDirectory } = {}) {
  const ring = createKeyring(env), keyId = await ring.current.keyId();
  const files = await migrationFiles(directory), applied = await migrationState(database, files);
  if (!applied || applied.length !== files.length) throw new Error('Apply all migrations with the command migrate before rewrap-secrets.');
  const summary = { keyId, checked: 0, rewrapped: 0, unchanged: 0, failed: 0 };
  for (const { table, key } of encryptedColumns) {
    const rows = await database.query(sql`SELECT ${sql.ident(key)} AS id,principal,secret_enc FROM ${sql.ident(table)} WHERE secret_enc <> ${authenticatorManaged} ORDER BY ${sql.ident(key)}`);
    for (const row of rows) {
      summary.checked++;
      if (!await needsRewrap(ring, row.secret_enc)) { summary.unchanged++; continue; }
      let value;
      try {
        value = await encryptWithKeyring(ring, await decryptWithKeyring(ring, row.secret_enc, row.principal), row.principal);
      } catch {
        summary.failed++;
        continue;
      }
      const updated = await database.transaction(async tx => {
        const result = await tx.exec(sql`UPDATE ${sql.ident(table)} SET secret_enc = ${value} WHERE ${sql.ident(key)} = ${row.id} AND principal = ${row.principal} AND secret_enc = ${row.secret_enc}`);
        // A pending replacement guards on the authenticator's old value; move it
        // along in the same transaction, and only if this update took effect.
        if (table === 'mfa_authenticators') {
          await tx.exec(sql`UPDATE mfa_authenticator_challenges SET previous_secret_enc = ${value} WHERE authenticator_id = ${row.id} AND previous_secret_enc = ${row.secret_enc} AND EXISTS (SELECT 1 FROM mfa_authenticators WHERE id = ${row.id} AND secret_enc = ${value})`);
        }
        return result.rowCount;
      });
      if (updated === 1) summary.rewrapped++;
      else summary.unchanged++;
    }
  }
  // Notification channel secrets: the password, URL and signing key of a channel
  // as one ciphertext (lib/server/notifications/notification-channels.ts), with the channel ID in the context.
  const channels = await database.query(sql`SELECT id,secret FROM notification_channels WHERE secret IS NOT NULL ORDER BY id`);
  for (const row of channels) {
    summary.checked++;
    if (!await needsRewrap(ring, row.secret)) { summary.unchanged++; continue; }
    const context = `notification-channel:${row.id}`;
    let value;
    try {
      value = await encryptWithKeyring(ring, await decryptWithKeyring(ring, row.secret, context), context);
    } catch {
      summary.failed++;
      continue;
    }
    const result = await database.exec(sql`UPDATE notification_channels SET secret = ${value} WHERE id = ${row.id} AND secret = ${row.secret}`);
    if (result.rowCount === 1) summary.rewrapped++;
    else summary.unchanged++;
  }
  // The NVD API key of the vulnerability check (lib/server/devices/vulnerabilities.ts), context vulnerability-api-key.
  const apiKey = await database.one(sql`SELECT api_key FROM vulnerability_settings WHERE id = 1 AND api_key IS NOT NULL`);
  if (apiKey) {
    summary.checked++;
    if (!await needsRewrap(ring, apiKey.api_key)) summary.unchanged++;
    else {
      let value = null;
      try { value = await encryptWithKeyring(ring, await decryptWithKeyring(ring, apiKey.api_key, 'vulnerability-api-key'), 'vulnerability-api-key'); }
      catch { summary.failed++; }
      if (value !== null) {
        const result = await database.exec(sql`UPDATE vulnerability_settings SET api_key = ${value} WHERE id = 1 AND api_key = ${apiKey.api_key}`);
        if (result.rowCount === 1) summary.rewrapped++;
        else summary.unchanged++;
      }
    }
  }
  // The provider keys of the device assistant (lib/server/devices/assistant-settings.ts): context
  // assistant-key:organization, assistant-key:user:<user_id> for a personal key
  // and assistant-key:customer:<customer_id> for a customer key.
  const assistantKeys = await database.query(sql`SELECT id,scope,user_id,customer_id,secret FROM assistant_keys ORDER BY id`);
  for (const row of assistantKeys) {
    summary.checked++;
    if (!await needsRewrap(ring, row.secret)) { summary.unchanged++; continue; }
    const context = row.scope === 'organization' ? 'assistant-key:organization' : row.scope === 'customer' ? `assistant-key:customer:${row.customer_id}` : `assistant-key:user:${row.user_id}`;
    let value;
    try {
      value = await encryptWithKeyring(ring, await decryptWithKeyring(ring, row.secret, context), context);
    } catch {
      summary.failed++;
      continue;
    }
    const result = await database.exec(sql`UPDATE assistant_keys SET secret = ${value} WHERE id = ${row.id} AND secret = ${row.secret}`);
    if (result.rowCount === 1) summary.rewrapped++;
    else summary.unchanged++;
  }
  // The kid is public (it is in the output too); the counters are the record.
  const target = `Key ${keyId}, checked ${summary.checked}, rewrapped ${summary.rewrapped}, unchanged ${summary.unchanged}, failed ${summary.failed}`;
  await database.exec(sql`INSERT INTO audit (at,actor,action,target,server_id,scope,customer_id) VALUES(${Date.now()},'System',${secretsRewrapAuditAction},${target},NULL,'portal',NULL)`);
  return summary;
}

async function rewrap(database) {
  const result = await rewrapSecrets(database);
  if (result.failed > 0) {
    console.error(`ServerDesk: ${rewrapFailureMessage(result.failed)}`);
    process.exitCode = 1;
  }
  return result;
}

/** The stderr text (without "ServerDesk: ") of reset-totp without --confirm. */
export const resetTotpConfirmMessage = 'reset-totp deletes every stored authenticator app. Run it again with --confirm.';
// Every principal with a stored TOTP secret: an authenticator app, a pending
// first setup, a pending app setup or replacement, or an account that still
// keeps its secret in mfa_accounts.
const totpPrincipals = sql`SELECT principal FROM mfa_authenticators UNION SELECT principal FROM mfa_challenges
  UNION SELECT principal FROM mfa_authenticator_challenges UNION SELECT principal FROM mfa_accounts WHERE secret_enc <> ${authenticatorManaged}`;
const hasPasskey = sql`EXISTS (SELECT 1 FROM passkey_credentials passkey WHERE passkey.principal = account.principal)`;

/**
 * Deletes every stored TOTP secret in one transaction, for a SESSION_SECRET
 * that leaked together with a copy of the database. An affected account (one
 * with a TOTP secret) with a passkey becomes passkey-only: its anchor gets the
 * sentinel and authenticators_migrated = 1, its recovery codes and created_at
 * stay. An affected account without a passkey loses its mfa_accounts row and
 * enrolls again at the next sign-in. The MFA sessions, MFA grants and
 * proofs of every affected principal end. Accounts without a TOTP secret stay
 * unchanged. The audit row and the result hold counters only.
 */
export async function resetTotp(database, { confirm = false, directory = migrationDirectory } = {}) {
  if (confirm !== true) throw new Error(resetTotpConfirmMessage);
  const files = await migrationFiles(directory), applied = await migrationState(database, files);
  if (!applied || applied.length !== files.length) throw new Error('Apply all migrations with the command migrate before reset-totp.');
  return database.transaction(async tx => {
    const { count } = await tx.one(sql`SELECT count(*) AS count FROM (${totpPrincipals}) affected`);
    // Sessions and proofs first, while the TOTP rows still name the principals.
    for (const table of ['mfa_sessions', 'mfa_grants', 'mfa_proofs', 'mfa_management_proofs']) {
      await tx.exec(sql`DELETE FROM ${sql.ident(table)} WHERE principal IN (${totpPrincipals})`);
    }
    const removed = await tx.exec(sql`DELETE FROM mfa_accounts account WHERE account.principal IN (${totpPrincipals}) AND NOT ${hasPasskey}`);
    const passkeyOnly = await tx.exec(sql`UPDATE mfa_accounts account SET secret_enc = ${authenticatorManaged}, authenticators_migrated = 1, last_counter = -1 WHERE account.principal IN (${totpPrincipals}) AND ${hasPasskey}`);
    const replacements = await tx.exec(sql`DELETE FROM mfa_authenticator_challenges`);
    const setups = await tx.exec(sql`DELETE FROM mfa_challenges`);
    const authenticators = await tx.exec(sql`DELETE FROM mfa_authenticators`);
    const result = { accounts: Number(count), authenticators: authenticators.rowCount, pendingSetups: replacements.rowCount + setups.rowCount, passkeyOnly: passkeyOnly.rowCount, mfaRemoved: removed.rowCount };
    const target = `Accounts ${result.accounts}, authenticators ${result.authenticators}, pending setups ${result.pendingSetups}, passkey-only ${result.passkeyOnly}, MFA removed ${result.mfaRemoved}`;
    await tx.exec(sql`INSERT INTO audit (at,actor,action,target,server_id,scope,customer_id) VALUES(${Date.now()},'System',${totpResetAuditAction},${target},NULL,'portal',NULL)`);
    return result;
  });
}

/**
 * import-release <dir>: one agent release folder into the catalog, offline.
 * Refuses before it reads the folder when a migration is missing.
 */
export async function importRelease(database, { directory, env = process.env, migrations = migrationDirectory, storage, publicKeyPem } = {}) {
  const files = await migrationFiles(migrations), applied = await migrationState(database, files);
  if (!applied || applied.length !== files.length) throw new Error('Apply all migrations with the command migrate before import-release.');
  const { createStorage } = await import('../runtime/storage.mjs');
  return importReleaseFolder(database, {
    directory, storage: storage ?? createStorage(env), ...(publicKeyPem ? { publicKeyPem } : {}),
  });
}

/** The backup directory: BACKUP_DIRECTORY, else .data/backups in the project. */
export function backupDirectory(env = process.env) {
  return path.resolve(projectRoot, env.BACKUP_DIRECTORY || path.join('.data', 'backups'));
}

export const usage = [
  'Usage: node --env-file=.env.local scripts/selfhost.mjs migrate [--skip-backup]',
  '       node --env-file=.env.local scripts/selfhost.mjs bootstrap-owner --username admin --display-name "Administrator" [--email admin@example.com]',
  '       node --env-file=.env.local scripts/selfhost.mjs maintenance [--audit-days 30] [--job-days 30] [--software-days 365] [--alert-days 90]',
  '       node --env-file=.env.local scripts/selfhost.mjs rewrap-secrets',
  '       node --env-file=.env.local scripts/selfhost.mjs reset-totp --confirm',
  '       node --env-file=.env.local scripts/selfhost.mjs import-release <dir>',
  '       node --env-file=.env.local scripts/selfhost.mjs backup [--output <file>]',
  '       node --env-file=.env.local scripts/selfhost.mjs restore --input <file> [--replace]',
].join('\n');

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h') {
    console.log(usage);
    return;
  }
  if (!['migrate', 'bootstrap-owner', 'maintenance', 'rewrap-secrets', 'reset-totp', 'import-release', 'backup', 'restore'].includes(command)) throw new Error(`Unknown command: ${command}`);
  const migrateOptions = command === 'migrate' ? parseFlags(args, [], ['--skip-backup']) : undefined;
  if (command === 'rewrap-secrets' && args.length) throw new Error('rewrap-secrets accepts no further arguments.');
  // Check the arguments before opening anything, so a refused run changes nothing.
  if (command === 'reset-totp') {
    if (args.length > 1 || args.some(argument => argument !== '--confirm')) throw new Error('reset-totp accepts only --confirm.');
    if (!args.length) throw new Error(resetTotpConfirmMessage);
  }
  if (command === 'import-release' && (args.length !== 1 || args[0].startsWith('--'))) throw new Error('import-release needs exactly one folder: import-release <dir>.');
  const backupOptions = command === 'backup' ? parseFlags(args, ['--output']) : undefined;
  const restoreOptions = command === 'restore' ? parseFlags(args, ['--input'], ['--replace']) : undefined;
  if (restoreOptions && !restoreOptions['--input']) throw new Error('restore needs --input <file>.');
  // Build the keyring before opening anything, so a short secret changes nothing.
  if (command === 'rewrap-secrets') createKeyring(process.env);
  const options = command === 'bootstrap-owner' ? parseArguments(args) : undefined;
  // Check the retention flags before opening anything, so an invalid flag changes nothing.
  const maintenanceFlags = command === 'maintenance' ? parseFlags(args, ['--audit-days', '--job-days', '--software-days', '--alert-days']) : undefined;
  if (maintenanceFlags) resolveRetention({ args: maintenanceFlags });
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set. Set it to the PostgreSQL URL, for example postgres://serverdesk@db:5432/serverdesk.');
  const password = process.env.DATABASE_PASSWORD;
  const { createDatabase } = await import('../runtime/database.mjs');
  const invocationDirectory = process.cwd();
  process.chdir(projectRoot);
  const database = createDatabase({ url, password, max: 2 });
  try {
    let result;
    if (command === 'migrate') {
      if (migrateOptions['--skip-backup']) console.error('ServerDesk: migrate runs without a backup (--skip-backup).');
      result = await migrateDatabase(database, {
        backup: { url, password, directory: backupDirectory(), skip: !!migrateOptions['--skip-backup'] },
        notice: message => console.error('ServerDesk: ' + message),
      });
    } else if (command === 'maintenance') result = await maintenance(database, maintenanceFlags);
    else if (command === 'rewrap-secrets') result = await rewrap(database);
    else if (command === 'reset-totp') result = await resetTotp(database, { confirm: true });
    else if (command === 'import-release') result = await importRelease(database, { directory: path.resolve(invocationDirectory, args[0]) });
    else if (command === 'backup') {
      const file = backupOptions['--output'] ? path.resolve(invocationDirectory, backupOptions['--output']) : await uniqueFile(path.join(backupDirectory(), `serverdesk-${fileTime()}`), '.dump');
      result = await dumpDatabase(database, { url, password, file });
    } else if (command === 'restore') {
      result = await restoreDatabase(database, { url, password, file: path.resolve(invocationDirectory, restoreOptions['--input']), replace: !!restoreOptions['--replace'] });
    } else result = await bootstrapOwner(database, options);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await database.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error('ServerDesk: ' + (error instanceof Error ? error.message : 'Offline administration failed.'));
    process.exitCode = 1;
  });
}
