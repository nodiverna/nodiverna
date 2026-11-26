import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import migrations from '../drizzle/meta/_journal.json' with { type: 'json' };
import { sql } from './database.mjs';
import { auditRetentionAuditAction, maintenanceRunAuditAction } from './audit-actions.mjs';
import { maintenanceReleaseCheck } from './release-import.mjs';
import { sendUsageReport } from './usage-report.mjs';

/**
 * Maintenance: the audit, job, software change and alarm retention, the
 * transfer cleanup, the daily usage report and the check for new agent
 * releases on GitHub (runtime/release-import.mjs). One module for the portal process (the scheduler in
 * runtime/maintenance-scheduler.mjs and Run now in lib/server/maintenance.ts) and the
 * support tool scripts/selfhost.mjs maintenance.
 *
 * Every run first takes the lease in maintenance_lock with one conditional
 * statement, so only one run is active across all instances and replicas. The
 * holder renews the lease every 60 seconds and clears it at the end. A run that
 * stops without clearing it (a crash, a stopped container) leaves a lease that
 * expires after 10 minutes; the next run takes it over and records the run of
 * the old lease as failed. A run starts only when every shipped migration is
 * applied, and every run writes one maintenance_runs row with its trigger.
 */

const dayMs = 86_400_000;
export const maintenanceLeaseMs = 10 * 60_000;
export const maintenanceRenewMs = 60_000;
/** At most this many runs per slot: the scheduled run and its continuations, or a manual run and its continuations. */
export const maintenanceChainLimit = 24;
export const defaultRetentionDays = 30;
/** The software change history (device_software_changes) is kept longer by default. */
export const defaultSoftwareRetentionDays = 365;
/** Closed alarms (alerts) are kept 90 days by default: the history shows trends. */
export const defaultAlertRetentionDays = 90;
/** Agent integrity events (lib/server/agent/agent-integrity.ts) are kept 90 days, like AGENT_INTEGRITY_RETENTION_MS. */
export const agentIntegrityRetentionDays = 90;
/**
 * Days the portal keeps the script of an assistant-powershell job in
 * jobs.display_input, so the job drawer can show it. Then runMaintenance removes
 * the key script: an admin may have pasted a secret into it, and the job
 * retention keeps a job for up to 3650 days. The other kept keys stay.
 */
export const assistantScriptRetentionDays = 7;
export const maintenanceTriggers = ['schedule', 'continuation', 'manual', 'cli'];

export const maintenanceMigrationsMessage = 'Apply all migrations with the command migrate before maintenance.';
export const maintenanceWaitingMessage = 'Maintenance waits until all migrations are applied.';
export const maintenanceLockHeldMessage = 'Maintenance is already running on another instance. Try again later.';
export const maintenanceLockLostMessage = 'Maintenance stopped because another instance took over the lock.';
// The text that takeovers stored before the reason keys; storedMaintenanceError maps old rows by it.
export const maintenanceLockExpiredMessage = 'The run stopped before it finished. The lock expired and another run took over.';
/** A continuation starts at least this long after the run before it ended. */
export const maintenanceContinuationGapMs = 60_000;
/** The portal audit action of Run now; the row commits with the 'manual' run row. */
export { maintenanceRunAuditAction };

// ---- Failure reasons -------------------------------------------------------------

/**
 * Every reason a run can fail with. A failed maintenance_runs row stores
 * serverMessage.maintenance.<reason> in error, never a raw message: the page
 * shows the catalog text of the key, the raw details go to the server log.
 * retentionInvalid: an invalid *_RETENTION_DAYS start value; lockLost: another
 * instance took the lock during the run; lockExpired: the run of an expired
 * lease, recorded at the takeover; transfersFailed: transfers could not be
 * cleared; internal: every other error.
 */
export const maintenanceFailures = Object.freeze(['retentionInvalid', 'lockLost', 'lockExpired', 'transfersFailed', 'internal']);
export const maintenanceErrorKey = reason => `serverMessage.maintenance.${reason}`;
const failureKeys = new Set(maintenanceFailures.map(maintenanceErrorKey));

/** An error with a failure reason; the message stays English operator text for the log and the CLI. */
export class MaintenanceFailure extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'MaintenanceFailure';
    this.reason = reason;
  }
}

/** The stored key of a thrown error: its reason marker, else internal. Never reads the message. */
export const maintenanceFailureKey = error => maintenanceErrorKey(error instanceof MaintenanceFailure && maintenanceFailures.includes(error.reason) ? error.reason : 'internal');

/**
 * The reason key of a stored error value for the page, or null. A stored key
 * stays; rows from before the keys are mapped by their exact old texts, and
 * every other value is internal, so no raw text leaves the server.
 */
export function storedMaintenanceError(value) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  if (failureKeys.has(text)) return text;
  if (text === maintenanceLockLostMessage) return maintenanceErrorKey('lockLost');
  if (text === maintenanceLockExpiredMessage) return maintenanceErrorKey('lockExpired');
  if (/^\d+ transfers could not be cleared/.test(text)) return maintenanceErrorKey('transfersFailed');
  if (/^[A-Z_]+_RETENTION_DAYS: enter a whole number/.test(text)) return maintenanceErrorKey('retentionInvalid');
  return maintenanceErrorKey('internal');
}

// ---- Migrations --------------------------------------------------------------

/** The migration file names this build ships (drizzle/meta/_journal.json), as lib/server/readiness.ts reads them. */
export const shippedMigrationNames = (journal = migrations) => journal.entries.map(entry => `${entry.tag}.sql`);

/**
 * True when a shipped migration is not applied yet: the same check as isReady
 * in lib/server/readiness.ts. A database without the journal table has every
 * migration pending; newer extra journal rows are allowed.
 */
export async function migrationsPending(database, journal = migrations) {
  const required = shippedMigrationNames(journal);
  const table = await database.one(sql`SELECT to_regclass('public._serverdesk_migrations') IS NOT NULL AS present`);
  if (!table?.present) return true;
  const applied = await database.query(sql`SELECT name FROM _serverdesk_migrations WHERE name IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify(required)}::jsonb))`);
  const names = new Set(applied.map(row => row.name));
  return required.some(name => !names.has(name));
}

// ---- Retention ---------------------------------------------------------------

const retentionSources = {
  auditDays: { flag: '--audit-days', env: 'AUDIT_RETENTION_DAYS' },
  jobDays: { flag: '--job-days', env: 'JOB_RETENTION_DAYS' },
};
// The software change retention has no stored setting and no field on the page
// Settings → Data retention: CLI flag, then environment variable, then 365 days.
const softwareRetentionSource = { flag: '--software-days', env: 'SOFTWARE_CHANGE_RETENTION_DAYS' };
// The alarm retention, the same way: CLI flag, then environment variable, then 90 days.
const alertRetentionSource = { flag: '--alert-days', env: 'ALERT_RETENTION_DAYS' };
// The values without a stored setting: key, source, default.
const environmentOnlySources = [['softwareDays', softwareRetentionSource, defaultSoftwareRetentionDays], ['alertDays', alertRetentionSource, defaultAlertRetentionDays]];

export function retentionDays(value, source) {
  const text = typeof value === 'number' ? String(value) : value;
  const days = typeof text === 'string' && /^\d{1,4}$/.test(text) ? Number(text) : NaN;
  if (!(days >= 1 && days <= 3650)) throw new MaintenanceFailure('retentionInvalid', `${source}: enter a whole number of days from 1 to 3650.`);
  return days;
}

// An empty variable (e.g. from a Compose default) counts as unset.
const environmentValue = (env, variable) => (env?.[variable] !== undefined && env[variable] !== '' ? env[variable] : undefined);

/**
 * The single place where the instance retention is decided, per value: CLI
 * flag (one run only, never stored), then the stored setting of the page
 * Settings → Maintenance, then the environment variable, then 30 days. Without
 * a flag or a stored value an invalid variable throws. runMaintenance applies
 * auditDays as the instance default; a customer's own audit retention, stored in
 * customers.audit_retention_days, takes precedence for that customer's rows.
 * softwareDays (the software change history) skips the stored step and falls
 * back to 365 days; alertDays (closed alarms) does the same with 90 days.
 */
export function resolveRetention({ args = {}, env = {}, stored = {} } = {}) {
  const retention = {};
  for (const [key, { flag, env: variable }] of Object.entries(retentionSources)) {
    const fromEnvironment = environmentValue(env, variable);
    if (args[flag] !== undefined) retention[key] = retentionDays(args[flag], flag);
    else if (stored?.[key] !== undefined && stored[key] !== null) retention[key] = retentionDays(Number(stored[key]), key);
    else if (fromEnvironment !== undefined) retention[key] = retentionDays(fromEnvironment, variable);
    else retention[key] = defaultRetentionDays;
  }
  for (const [key, { flag, env: variable }, fallback] of environmentOnlySources) {
    const fromEnvironment = environmentValue(env, variable);
    if (args[flag] !== undefined) retention[key] = retentionDays(args[flag], flag);
    else if (fromEnvironment !== undefined) retention[key] = retentionDays(fromEnvironment, variable);
    else retention[key] = fallback;
  }
  return retention;
}

/**
 * The effective retention of the settings page, per value: the value (null for
 * an invalid environment value), where it comes from, and whether the
 * environment value is invalid while no stored value hides it.
 * @param {{auditDays?: number|null, jobDays?: number|null}|null|undefined} stored
 * @param {Record<string, string|undefined>|undefined} env
 * @returns {{values: {auditDays: number|null, jobDays: number|null}, source: {auditDays: 'stored'|'env'|'default', jobDays: 'stored'|'env'|'default'}, envInvalid: {auditDays: boolean, jobDays: boolean}}}
 */
export function retentionSourceView(stored, env) {
  /** @type {any} */
  const values = {}, source = {}, envInvalid = {};
  for (const [key, { env: variable }] of Object.entries(retentionSources)) {
    const fromEnvironment = environmentValue(env, variable);
    envInvalid[key] = false;
    if (stored?.[key] !== undefined && stored[key] !== null) {
      values[key] = Number(stored[key]);
      source[key] = 'stored';
    } else if (fromEnvironment !== undefined) {
      source[key] = 'env';
      try { values[key] = retentionDays(fromEnvironment, variable); } catch { values[key] = null; envInvalid[key] = true; }
    } else {
      values[key] = defaultRetentionDays;
      source[key] = 'default';
    }
  }
  return { values, source, envInvalid };
}

/**
 * The effective retention of the values without a stored setting (software
 * changes, alarms and notifications), as the page Settings → Data retention
 * shows it: the same days as resolveRetention({env}) without flags, where it
 * comes from, and whether the variable is invalid (days null instead of a throw).
 * @param {Record<string, string|undefined>|undefined} env
 * @returns {{softwareDays: EnvironmentRetention, alertDays: EnvironmentRetention}}
 */
export function environmentRetentionView(env) {
  /** @type {any} */
  const view = {};
  for (const [key, { env: variable }, fallback] of environmentOnlySources) {
    const fromEnvironment = environmentValue(env, variable);
    if (fromEnvironment === undefined) view[key] = { days: fallback, source: 'default', envInvalid: false };
    else {
      try { view[key] = { days: retentionDays(fromEnvironment, variable), source: 'env', envInvalid: false }; } catch { view[key] = { days: null, source: 'env', envInvalid: true }; }
    }
  }
  return view;
}
/** @typedef {{days: number|null, source: 'env'|'default', envInvalid: boolean}} EnvironmentRetention */

// ---- Settings ----------------------------------------------------------------

/** The stored maintenance settings (table maintenance_settings, row 1). runAt is minutes after midnight. */
export async function readMaintenanceSettings(database) {
  const row = await database.one(sql`SELECT audit_days,job_days,run_at,time_zone,revision,updated_at,updated_by FROM maintenance_settings WHERE id=1`);
  if (!row) throw new Error('maintenance_settings is missing. Apply all migrations with the command migrate.');
  return {
    auditDays: row.audit_days === null ? null : Number(row.audit_days),
    jobDays: row.job_days === null ? null : Number(row.job_days),
    runAt: Number(row.run_at),
    timeZone: row.time_zone,
    revision: Number(row.revision),
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

// ---- Daily slot ----------------------------------------------------------------

const formatters = new Map();
function formatter(timeZone) {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
    formatters.set(timeZone, format);
  }
  return format;
}

/** Whether Intl knows the zone. */
export function knownTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone) return false;
  try { formatter(timeZone); return true; } catch { return false; }
}

/** The wall-clock time of an instant in the zone as a UTC timestamp ("naive" time), whole minutes. */
function naiveTime(instant, timeZone) {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(instant).map(part => [part.type, part.value]));
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute));
}

/** Every instant (whole minutes) whose wall-clock time in the zone is the naive time: one, two at a fall-back, none in a gap. */
function instantsOf(naive, timeZone) {
  const found = new Set();
  for (const probe of [naive - 14 * 3_600_000, naive - 3_600_000, naive, naive + 3_600_000, naive + 14 * 3_600_000]) {
    const candidate = naive - (naiveTime(probe, timeZone) - Math.floor(probe / 60_000) * 60_000);
    if (naiveTime(candidate, timeZone) === naive) found.add(candidate);
  }
  return [...found].sort((a, b) => a - b);
}

/** The instants of the run time on one local day; a time in a DST gap falls to the next valid minute. */
function dayInstants(day, runAt, timeZone) {
  for (let shift = 0; shift <= 24 * 60; shift++) {
    const instants = instantsOf(day + (runAt + shift) * 60_000, timeZone);
    if (instants.length) return instants;
  }
  return [];
}

const zone = timeZone => (knownTimeZone(timeZone) ? timeZone : 'UTC');
const localDay = (instant, timeZone) => Math.floor(naiveTime(instant, timeZone) / dayMs) * dayMs;

/**
 * The slot of a daily run: the latest moment at or before `now` at which the
 * wall-clock time in `timeZone` is `runAt` (minutes after midnight). DST
 * comes from Intl; a time that does not exist on the day of a change falls to
 * the next valid minute.
 */
export function maintenanceSlot(now, runAt, timeZone) {
  const tz = zone(timeZone), today = localDay(now, tz);
  for (let back = 0; back <= 2; back++) {
    const candidates = dayInstants(today - back * dayMs, runAt, tz).filter(instant => instant <= now);
    if (candidates.length) return Math.max(...candidates);
  }
  throw new Error('No maintenance slot found.');
}

/** The first slot after `now`. */
export function nextMaintenanceSlot(now, runAt, timeZone) {
  const tz = zone(timeZone), today = localDay(now, tz);
  for (let ahead = 0; ahead <= 2; ahead++) {
    const candidates = dayInstants(today + ahead * dayMs, runAt, tz).filter(instant => instant > now);
    if (candidates.length) return Math.min(...candidates);
  }
  throw new Error('No maintenance slot found.');
}

/** Whether a run started at or after the slot (any trigger). */
export async function startedSince(database, slot) {
  return !!await database.one(sql`SELECT 1 AS found FROM maintenance_runs WHERE started_at >= ${slot} LIMIT 1`);
}

// ---- Automatic continuation ------------------------------------------------------

const parseResult = text => { try { return typeof text === 'string' ? JSON.parse(text) : null; } catch { return null; } };

/** Whether any area of a run result has more rows than one run deletes. */
export function resultHasMore(result) {
  if (!result || typeof result !== 'object') return false;
  return [result.audit, ...(Array.isArray(result.customerAudit) ? result.customerAudit : []), result.jobs, result.jobOutputs, result.assistantScripts, result.softwareChanges, result.alerts, result.notifications, result.integrityEvents, result.transfers].some(area => area?.more === true);
}

/**
 * The pending continuation, or null: the newest run is a succeeded scheduled,
 * continuation or manual run with more to delete, and its chain (the run that
 * started it and the continuations since) has fewer than 24 runs. A failed run
 * and a CLI run end the chain. `dueAt` is the earliest start: one minute after
 * the newest run ended (continuationDue).
 */
export async function pendingContinuation(database) {
  const rows = await database.query(sql`SELECT id,trigger,status,started_at,finished_at,result FROM maintenance_runs ORDER BY started_at DESC,id DESC LIMIT ${maintenanceChainLimit}`);
  const [newest] = rows;
  if (!newest || newest.status !== 'succeeded' || newest.trigger === 'cli' || !resultHasMore(parseResult(newest.result))) return null;
  let length = 0;
  for (const row of rows) {
    length++;
    if (row.trigger !== 'continuation') break;
  }
  const ended = Number(newest.finished_at ?? newest.started_at);
  return length < maintenanceChainLimit ? { after: newest.id, length, dueAt: ended + maintenanceContinuationGapMs } : null;
}

/** Whether a pending continuation may start at `now`: at least one minute after the run before it ended. */
export const continuationDue = (continuation, now) => !!continuation && now >= continuation.dueAt;

// ---- Lock ----------------------------------------------------------------------

/** A new lease holder: <hostname>:<pid>:<random>. */
export const newLockHolder = () => `${hostname()}:${process.pid}:${randomBytes(6).toString('hex')}`;

/**
 * Takes the lease in one conditional statement: it succeeds only when the lock
 * is free or its lease expired. Taking over an expired lease marks the run it
 * names as failed, if that run is still running, in the same transaction.
 * Returns whether this holder has the lock now.
 */
export async function acquireMaintenanceLock(database, { holder, now, leaseMs = maintenanceLeaseMs }) {
  return database.transaction(async tx => {
    const taken = await tx.one(sql`WITH previous AS (SELECT holder,run_id FROM maintenance_lock WHERE id=1 FOR UPDATE)
      UPDATE maintenance_lock SET holder=${holder},run_id=NULL,acquired_at=${now},expires_at=${now + leaseMs}
      FROM previous WHERE maintenance_lock.id=1 AND (maintenance_lock.holder IS NULL OR maintenance_lock.expires_at < ${now})
      RETURNING previous.holder AS previous_holder,previous.run_id AS previous_run`);
    if (!taken) return false;
    if (taken.previous_holder !== null && taken.previous_run !== null) {
      await tx.exec(sql`UPDATE maintenance_runs SET status='failed',finished_at=GREATEST(${now}::bigint,started_at),error=${maintenanceErrorKey('lockExpired')} WHERE id=${taken.previous_run} AND status='running'`);
    }
    return true;
  });
}

/** Moves the lease end of this holder; false when another holder took the lock. */
export async function renewMaintenanceLock(database, { holder, now, leaseMs = maintenanceLeaseMs }) {
  return (await database.exec(sql`UPDATE maintenance_lock SET expires_at=${now + leaseMs} WHERE id=1 AND holder=${holder}`)).rowCount === 1;
}

/** Clears the lock if this holder still has it. */
export async function releaseMaintenanceLock(database, holder) {
  await database.exec(sql`UPDATE maintenance_lock SET holder=NULL,run_id=NULL,acquired_at=NULL,expires_at=NULL WHERE id=1 AND holder=${holder}`);
}

// ---- The retention and cleanup work ------------------------------------------------

// Active transfer states that end through expires_at; cancelled and failed end
// immediately, expired is the cleared final state (see lib/server/devices/transfers.ts).
// tests/integration/selfhost-transfer-states.mjs fails when a transfer state in the code is missing here or in the immediately ending states.
const expiringTransferStates = ['uploading', 'pending', 'ready', 'active', 'completed'];
const expiringTransferList = sql.join(expiringTransferStates.map(state => sql`${state}`));
const transferClearable = now => sql`(state IN ('cancelled','failed') OR (state IN (${expiringTransferList}) AND expires_at < ${now}))`;

// The predicate of the partial index idx_jobs_assistant_script, as literals (never parameters).
const assistantScriptHeld = sql`action = 'assistant-powershell' AND display_input LIKE '%"script":%'`;

/**
 * Selection queries of runMaintenance. Each one must stay an index scan over
 * its retention index; tests check their query plans. Each takes its values
 * and the limit last.
 */
export const maintenanceSelections = {
  // Audit rows without customer (instance retention) and, per customer, its rows
  // (index idx_audit_customer_at). Customers without their own retention and
  // deleted customers (removed_customers) run with customerAudit as segments of
  // the instance pass.
  audit: (cutoff, limit) => sql`SELECT id FROM audit WHERE customer_id IS NULL AND at < ${cutoff} ORDER BY at LIMIT ${limit}`,
  customerAudit: (customerId, cutoff, limit) => sql`SELECT id FROM audit WHERE customer_id = ${customerId} AND at < ${cutoff} ORDER BY at LIMIT ${limit}`,
  jobs: (cutoff, limit) => sql`SELECT id FROM jobs WHERE created_at < ${cutoff} AND state NOT IN ('pending','running') ORDER BY created_at LIMIT ${limit}`,
  jobOutputs: (cutoff, limit) => sql`SELECT job_id FROM job_outputs WHERE created_at < ${cutoff} ORDER BY created_at LIMIT ${limit}`,
  // Ended assistant jobs whose display_input still holds the script (partial index idx_jobs_assistant_script,
  // migration 0033). The action and LIKE literals must stay exactly the index predicate, so the plan can use it.
  assistantScripts: (cutoff, limit) => sql`SELECT id FROM jobs WHERE ${assistantScriptHeld} AND created_at < ${cutoff} AND state NOT IN ('pending','running') ORDER BY created_at LIMIT ${limit}`,
  transfers: (now, limit) => sql`SELECT id,updated_at FROM transfers WHERE ${transferClearable(now)} ORDER BY updated_at LIMIT ${limit}`,
  // The software change history of every device (index idx_device_software_changes_at).
  softwareChanges: (cutoff, limit) => sql`SELECT id FROM device_software_changes WHERE at < ${cutoff} ORDER BY at LIMIT ${limit}`,
  // Closed alarms of every device (partial index idx_alerts_closed_at); open and pending alarms are never selected.
  alerts: (cutoff, limit) => sql`SELECT id FROM alerts WHERE state = 'closed' AND closed_at < ${cutoff} ORDER BY closed_at LIMIT ${limit}`,
  // Notification events with the alarm retention (index idx_notification_events_occurred); their deliveries
  // go by cascade. Pending events and events with a pending or sending delivery are never selected.
  notifications: (cutoff, limit) => sql`SELECT id FROM notification_events WHERE occurred_at < ${cutoff} AND status <> 'pending' AND NOT EXISTS (SELECT 1 FROM notification_deliveries open_delivery WHERE open_delivery.event_id = notification_events.id AND open_delivery.status IN ('pending','sending')) ORDER BY occurred_at LIMIT ${limit}`,
  // Agent integrity events of every device after 90 days (index idx_agent_integrity_events_received).
  integrityEvents: (cutoff, limit) => sql`SELECT id FROM agent_integrity_events WHERE received_at < ${cutoff} ORDER BY received_at LIMIT ${limit}`,
};
/** The transfer states that runMaintenance clears once expires_at has passed. */
export const maintenanceTransferStates = expiringTransferStates;

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer.`);
  return value;
}

/**
 * Deletes rows in bounded batches. `selection(...values, limit)` selects the
 * keys of one batch. With summary(deleted, lastAllowed), each batch runs as one
 * transaction: the delete, then the summary row if this was the run's last
 * batch, so a failing summary row also rolls back the last delete.
 * `deletedBefore` counts rows that earlier segments of the same pass deleted.
 */
async function deleteInBatches(database, table, key, selection, values, batchSize, maxBatches, summary, deletedBefore = 0) {
  const statement = sql`DELETE FROM ${sql.ident(table)} WHERE ${sql.ident(key)} IN (${selection(...values, batchSize)})`;
  let deleted = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    const lastAllowed = batch === maxBatches - 1;
    const changes = summary
      ? await database.transaction(async tx => {
        const { rowCount } = await tx.exec(statement);
        const total = deletedBefore + deleted + rowCount;
        // The last batch of the run: fewer rows than a full batch, or the last allowed one.
        if ((rowCount < batchSize || lastAllowed) && total > 0) await tx.exec(summary(total));
        return rowCount;
      })
      : (await database.exec(statement)).rowCount;
    deleted += changes;
    if (changes < batchSize) return { deleted, more: false };
  }
  const remaining = await database.one(selection(...values, 1));
  return { deleted, more: remaining !== null };
}

/**
 * Removes the key script from display_input of the ended assistant jobs older
 * than the cutoff, in bounded batches like deleteInBatches. The other keys
 * (timeoutSeconds) stay. The UPDATE repeats the predicate, so a concurrent run
 * that already cleared a row neither changes nor counts it again.
 */
async function clearAssistantScripts(database, cutoff, batchSize, maxBatches) {
  const selection = maintenanceSelections.assistantScripts;
  const statement = sql`UPDATE jobs SET display_input = (display_input::jsonb - 'script')::text WHERE id IN (${selection(cutoff, batchSize)}) AND ${assistantScriptHeld}`;
  let cleared = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    const { rowCount } = await database.exec(statement);
    cleared += rowCount;
    if (rowCount < batchSize) return { cleared, more: false };
  }
  const remaining = await database.one(selection(cutoff, 1));
  return { cleared, more: remaining !== null };
}

/**
 * One audit retention pass over its segments, each with its own batch budget.
 * Segments without rows to delete are skipped, and only the last remaining one
 * carries the pass's summary. So the pass writes at most one summary row, in
 * the transaction of its last delete, counting the rows of every segment; a
 * failing summary rolls back that last delete, as with a single selection.
 */
async function auditPass(database, segments, batchSize, maxBatches, summary) {
  const pending = [];
  for (const segment of segments) if (await database.one(segment.selection(...segment.values, 1))) pending.push(segment);
  let deleted = 0, more = false;
  for (const [index, segment] of pending.entries()) {
    const result = await deleteInBatches(database, 'audit', 'id', segment.selection, segment.values, batchSize, maxBatches,
      index === pending.length - 1 ? summary : undefined, deleted);
    deleted += result.deleted;
    more ||= result.more;
  }
  return { deleted, more };
}


/**
 * The portal audit row that records an audit retention run, with the number of
 * rows the run deleted. deleteInBatches writes it in the transaction of the
 * run's last delete, and only if the run deleted anything. The pass of a
 * customer with its own retention records its row with that customer_id; the
 * instance row keeps customer_id NULL.
 */
function auditSummary({ now, cutoff, auditDays, customerId = null }) {
  const prefix = `Cutoff ${new Date(cutoff).toISOString()}, retention ${auditDays} ${auditDays === 1 ? 'day' : 'days'}, deleted rows: `;
  return deleted => sql`INSERT INTO audit (at,actor,action,target,server_id,scope,customer_id) VALUES(${now},'System',${auditRetentionAuditAction},${prefix + deleted},NULL,'portal',${customerId})`;
}

// Same prefix as chunkKey in lib/server/devices/transfers.ts: transfers/<id>/<chunk>/<sha256>.
async function deleteTransferObjects(storage, id) {
  const prefix = `transfers/${id}/`;
  let cursor;
  do {
    const page = await storage.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
    const keys = page.objects.map(object => object.key);
    for (let index = 0; index < keys.length; index += 100) await storage.delete(keys.slice(index, index + 100));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

/**
 * Retention and transfer cleanup. Every statement is idempotent and bounded,
 * so a later or concurrent run simply continues the work.
 *
 * Audit: the instance pass deletes rows without customer and rows of customers
 * without their own retention, with retention.auditDays. Each customer with its
 * own retention (customers.audit_retention_days, also when disabled) gets its
 * own pass and summary row with its days; that value wins over the instance
 * default. Deleting after the agreed period is always right.
 *
 * The script of an ended assistant job leaves its display_input after
 * assistantScriptRetentionDays (clearAssistantScripts), also when the job
 * retention is longer.
 *
 * `checkpoint`, if given, runs before each area (the audit pass, each customer
 * pass, jobs, job output, assistant scripts, software changes, alarms, notifications, transfers); a run whose lock was taken over throws
 * there and stops before its next area.
 */
export async function runMaintenance(database, storage, {
  retention,
  now = Date.now(),
  batchSize = 500,
  maxBatches = 100,
  transferLimit = 100,
  checkpoint = async () => {},
} = {}) {
  const auditDays = retentionDays(retention?.auditDays, 'auditDays');
  const jobDays = retentionDays(retention?.jobDays, 'jobDays');
  // Callers from before the software inventory pass no softwareDays: the default applies.
  const softwareDays = retentionDays(retention?.softwareDays ?? defaultSoftwareRetentionDays, 'softwareDays');
  // The same for callers from before the alarms: the default applies.
  const alertDays = retentionDays(retention?.alertDays ?? defaultAlertRetentionDays, 'alertDays');
  positiveInteger(now, 'now');
  positiveInteger(batchSize, 'batchSize');
  positiveInteger(maxBatches, 'maxBatches');
  positiveInteger(transferLimit, 'transferLimit');
  const auditCutoff = now - auditDays * dayMs, jobCutoff = now - jobDays * dayMs;
  const customers = (await database.query(sql`SELECT id,audit_retention_days FROM customers ORDER BY id`))
    .map(row => ({ id: row.id, auditDays: row.audit_retention_days === null ? null : retentionDays(Number(row.audit_retention_days), `customers.audit_retention_days (${row.id})`) }));
  // The audit rows of a deleted customer keep its id and follow the instance retention.
  const removedCustomers = (await database.query(sql`SELECT id FROM removed_customers ORDER BY id`)).map(row => row.id);
  const result = { retention: { auditDays, jobDays, softwareDays, alertDays } };
  // A failing summary row rejects the run before jobs and transfers are touched.
  await checkpoint();
  result.audit = await auditPass(database, [
    { selection: maintenanceSelections.audit, values: [auditCutoff] },
    ...customers.filter(customer => customer.auditDays === null).map(customer => ({ selection: maintenanceSelections.customerAudit, values: [customer.id, auditCutoff] })),
    ...removedCustomers.map(id => ({ selection: maintenanceSelections.customerAudit, values: [id, auditCutoff] })),
  ], batchSize, maxBatches, auditSummary({ now, cutoff: auditCutoff, auditDays }));
  result.customerAudit = [];
  for (const customer of customers.filter(entry => entry.auditDays !== null)) {
    await checkpoint();
    const cutoff = now - customer.auditDays * dayMs;
    const { deleted, more } = await deleteInBatches(database, 'audit', 'id', maintenanceSelections.customerAudit, [customer.id, cutoff], batchSize, maxBatches,
      auditSummary({ now, cutoff, auditDays: customer.auditDays, customerId: customer.id }));
    result.customerAudit.push({ customerId: customer.id, auditDays: customer.auditDays, deleted, more });
  }
  await checkpoint();
  result.jobs = await deleteInBatches(database, 'jobs', 'id', maintenanceSelections.jobs, [jobCutoff], batchSize, maxBatches);
  await checkpoint();
  result.jobOutputs = await deleteInBatches(database, 'job_outputs', 'job_id', maintenanceSelections.jobOutputs, [jobCutoff], batchSize, maxBatches);
  await checkpoint();
  result.assistantScripts = await clearAssistantScripts(database, now - assistantScriptRetentionDays * dayMs, batchSize, maxBatches);
  await checkpoint();
  result.softwareChanges = await deleteInBatches(database, 'device_software_changes', 'id', maintenanceSelections.softwareChanges, [now - softwareDays * dayMs], batchSize, maxBatches);
  await checkpoint();
  result.alerts = await deleteInBatches(database, 'alerts', 'id', maintenanceSelections.alerts, [now - alertDays * dayMs], batchSize, maxBatches);
  await checkpoint();
  result.notifications = await deleteInBatches(database, 'notification_events', 'id', maintenanceSelections.notifications, [now - alertDays * dayMs], batchSize, maxBatches);
  await checkpoint();
  result.integrityEvents = await deleteInBatches(database, 'agent_integrity_events', 'id', maintenanceSelections.integrityEvents, [now - agentIntegrityRetentionDays * dayMs], batchSize, maxBatches);

  await checkpoint();
  const candidates = await database.query(maintenanceSelections.transfers(now, transferLimit + 1));
  const transfers = { cleared: 0, failed: 0, more: candidates.length > transferLimit };
  for (const { id, updated_at: seen } of candidates.slice(0, transferLimit)) {
    // Claim the transfer by moving updated_at, so a concurrent run skips it
    // instead of deleting the same objects. It also queues a failed transfer
    // behind the others for the next run.
    const claim = await database.exec(sql`UPDATE transfers SET updated_at=GREATEST(${now}::bigint,updated_at+1) WHERE id=${id} AND updated_at=${seen} AND ${transferClearable(now)}`);
    if (!claim.rowCount) continue;
    try {
      await deleteTransferObjects(storage, id);
    } catch {
      // Chunks and state stay untouched, so the next run retries this transfer.
      transfers.failed++;
      continue;
    }
    const marked = await database.transaction(async tx => {
      await tx.exec(sql`DELETE FROM transfer_chunks WHERE transfer_id=${id} AND EXISTS (SELECT 1 FROM transfers WHERE id=${id} AND ${transferClearable(now)})`);
      return tx.exec(sql`UPDATE transfers SET state='expired',updated_at=${now},message=COALESCE(message,'Zwischenspeicher abgelaufen') WHERE id=${id} AND ${transferClearable(now)}`);
    });
    transfers.cleared += marked.rowCount;
  }
  result.transfers = transfers;
  return result;
}

// ---- The run record ----------------------------------------------------------------

/** The text (without "ServerDesk: ") of a run that left transfers uncleared. */
export const transferFailureMessage = failed => `${failed} transfers could not be cleared. Check the file storage and run maintenance again.`;

/** The audit target of Run now: the trigger and the run id, so an auditor finds the history row. */
export const maintenanceRunAuditTarget = runId => `Run now, trigger manual, run ${runId}`;

/**
 * Inserts the 'running' row of a run. With `holder` the insert happens only
 * while that holder has the lock, and the lock names the row (run_id) in the
 * same transaction; then null means the lock was lost. A 'manual' run (Run
 * now) also writes its portal audit row in that transaction, with the account
 * label as actor, so the audit row exists exactly when the run row does.
 */
async function openRun(database, { clock, trigger, requestedBy, holder }) {
  if (!holder) {
    return (await database.one(sql`INSERT INTO maintenance_runs(started_at,status,trigger,requested_by) VALUES(${clock()},'running',${trigger},${requestedBy}) RETURNING id`)).id;
  }
  return database.transaction(async tx => {
    const startedAt = clock();
    const row = await tx.one(sql`INSERT INTO maintenance_runs(started_at,status,trigger,requested_by)
      SELECT ${startedAt}::bigint,'running',${trigger}::text,${requestedBy}::text WHERE EXISTS (SELECT 1 FROM maintenance_lock WHERE id=1 AND holder=${holder}) RETURNING id`);
    if (!row) return null;
    await tx.exec(sql`UPDATE maintenance_lock SET run_id=${row.id} WHERE id=1 AND holder=${holder}`);
    if (trigger === 'manual') {
      await tx.exec(sql`INSERT INTO audit (at,actor,action,target,server_id,scope,customer_id) VALUES(${startedAt},${requestedBy ?? 'System'},${maintenanceRunAuditAction},${maintenanceRunAuditTarget(row.id)},NULL,'portal',NULL)`);
    }
    return row.id;
  });
}

/**
 * Runs work() for the open row `id` and finishes the row: 'succeeded' when the
 * result has no failed transfers, else 'failed' with the transfersFailed key;
 * the whole result is stored as JSON in both cases. If work() throws, the row
 * gets the key of the error's reason (maintenanceFailureKey) and no result, and
 * the original error is rethrown. A row that is no longer 'running' (a takeover
 * recorded it) keeps its record.
 */
async function finishRun(database, id, work, clock) {
  const finish = (status, result, error) => database.exec(sql`UPDATE maintenance_runs SET finished_at=GREATEST(${clock()}::bigint,started_at),status=${status},result=${result === null ? null : JSON.stringify(result)},error=${error} WHERE id=${id} AND status='running'`);
  let result;
  try {
    result = await work();
  } catch (error) {
    // The original error matters more than its record: if this update fails
    // too, the row stays 'running', which never counts as a success.
    await finish('failed', null, maintenanceFailureKey(error)).catch(() => {});
    throw error;
  }
  const failed = Number(result?.transfers?.failed ?? 0);
  await finish(failed > 0 ? 'failed' : 'succeeded', result, failed > 0 ? maintenanceErrorKey('transfersFailed') : null);
  return result;
}

/**
 * Records one maintenance run in maintenance_runs around work(). The row is
 * inserted as 'running' first (with `trigger`, default 'cli', and
 * `requestedBy`) and finished by its own id, so concurrent runs each keep their
 * own row. See finishRun for the outcome.
 */
export async function recordMaintenanceRun(database, work, { clock = Date.now, trigger = 'cli', requestedBy = null } = {}) {
  const id = await openRun(database, { clock, trigger, requestedBy });
  return finishRun(database, id, work, clock);
}

// ---- One locked run ------------------------------------------------------------------

/** The retention of an in-app run: the stored setting, else the environment variable, else 30 days (software changes: the variable, else 365 days; alarms: the variable, else 90 days). */
export async function runRetention(database, env) {
  return resolveRetention({ env, stored: await readMaintenanceSettings(database) });
}

/**
 * Starts one maintenance run under the lock. Returns
 * {status:'migrations-pending'} or {status:'locked'} without writing a row,
 * {status:'skipped'} when `verify()` (called after the lock is taken) says the
 * run is no longer needed, else {status:'started', runId, finished}.
 * `finished` resolves with {status:'succeeded'|'failed', result?, error?} and
 * never rejects. Without `retention` the run resolves the stored setting and
 * the environment (runRetention); an invalid value fails the run.
 * @param {any} database
 * @param {{trigger: 'schedule'|'continuation'|'manual'|'cli', requestedBy?: string|null, storage: any, env?: Record<string, string|undefined>,
 *   fetch?: typeof globalThis.fetch, clock?: () => number, timers?: any, retention?: {auditDays: number, jobDays: number, softwareDays?: number, alertDays?: number}, verify?: () => Promise<boolean>,
 *   notice?: (message: string) => void, journal?: {entries: {tag: string}[]}, runOptions?: object, leaseMs?: number, renewMs?: number,
 *   releaseOptions?: object}} options
 * @returns {Promise<{status: 'migrations-pending'|'locked'|'skipped'|'started', runId?: number, finished?: Promise<{status: 'succeeded'|'failed', result?: any, error?: any}>}>}
 */
export async function startMaintenance(database, {
  trigger,
  requestedBy = null,
  storage,
  env = process.env,
  fetch = globalThis.fetch,
  clock = Date.now,
  timers = globalThis,
  retention,
  verify,
  notice = () => {},
  journal = migrations,
  runOptions = {},
  leaseMs = maintenanceLeaseMs,
  renewMs = maintenanceRenewMs,
  // Options of the release check (runtime/release-import.mjs runReleaseCheck), for tests.
  releaseOptions = {},
}) {
  if (!maintenanceTriggers.includes(trigger)) throw new TypeError(`Unknown maintenance trigger: ${trigger}`);
  if (await migrationsPending(database, journal)) return { status: 'migrations-pending' };
  const holder = newLockHolder();
  if (!await acquireMaintenanceLock(database, { holder, now: clock(), leaseMs })) return { status: 'locked' };
  let runId;
  try {
    if (verify && !await verify()) {
      await releaseMaintenanceLock(database, holder);
      return { status: 'skipped' };
    }
    runId = await openRun(database, { clock, trigger, requestedBy, holder });
  } catch (error) {
    await releaseMaintenanceLock(database, holder).catch(() => {});
    throw error;
  }
  if (runId === null) return { status: 'locked' };

  let lost = false;
  const renew = async () => {
    try {
      if (!await renewMaintenanceLock(database, { holder, now: clock(), leaseMs })) lost = true;
    } catch {
      // A failed renewal is tried again in 60 seconds; the lease lasts 10 minutes.
    }
  };
  const renewal = timers.setInterval(() => { void renew(); }, renewMs);
  renewal?.unref?.();
  const checkpoint = async () => { if (lost) throw new MaintenanceFailure('lockLost', maintenanceLockLostMessage); };
  const work = async () => {
    const applied = retention ?? await runRetention(database, env);
    const result = await runMaintenance(database, storage, { ...runOptions, retention: applied, now: clock(), checkpoint });
    await checkpoint();
    if (result.transfers.failed > 0) notice(transferFailureMessage(result.transfers.failed));
    // The usage report is statistics only: it never changes the run's status,
    // and no output names the payload or the URL (docs/usage-data.md). While usage data
    // is off (usageDataEnabled) it is {status:'disabled'} and prints nothing.
    const usageReport = await sendUsageReport(database, { env, fetch, now: clock() });
    if (usageReport.status === 'invalid-server') notice('LICENSE_SERVER_URL is invalid. No usage data was sent.');
    if (usageReport.status === 'failed') notice(`The usage data could not be sent (${usageReport.error}). The next run tries again.`);
    // The check for new agent releases only adds catalog entries: like the
    // usage report it never changes the run's status and never throws.
    const releaseImport = await maintenanceReleaseCheck(database, { storage, fetch, clock, timers, notice, ...releaseOptions });
    return { ...result, usageReport, releaseImport };
  };
  const finished = (async () => {
    try {
      const result = await finishRun(database, runId, work, clock);
      return { status: result.transfers.failed > 0 ? 'failed' : 'succeeded', result };
    } catch (error) {
      // The row holds only the reason key; the raw message goes to the server log.
      notice(`Maintenance run ${runId} failed: ${error instanceof Error ? error.message : String(error)}`);
      return { status: 'failed', error };
    } finally {
      timers.clearInterval(renewal);
      await releaseMaintenanceLock(database, holder).catch(() => {});
    }
  })();
  return { status: 'started', runId, finished };
}
