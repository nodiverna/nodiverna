import { sharedDatabase } from './database.mjs';
import {
  continuationDue, maintenanceSlot, maintenanceWaitingMessage, migrationsPending, nextMaintenanceSlot, pendingContinuation, readMaintenanceSettings, startMaintenance, startedSince,
} from './maintenance.mjs';

/**
 * The maintenance scheduler of the portal server process. One per process
 * (a globalThis key, so a module reload in next dev does not start a second
 * one); instrumentation.ts starts it in the production server and in next
 * dev. It does not start without DATABASE_URL or with MAINTENANCE_SCHEDULER=off.
 *
 * The first tick runs 30 seconds after the start, then one every 60 seconds.
 * A tick starts a run when the daily slot is due (no run of any trigger
 * started since the slot) or a continuation is pending (runtime/maintenance.mjs,
 * pendingContinuation) and due: at least 60 seconds after the run before it
 * ended, by the scheduler clock; an earlier tick waits for a later one. Settings are read at every tick, so a changed time,
 * time zone or retention applies without a restart. After it takes the lock it
 * checks the decision again; if another instance ran in the meantime it
 * releases the lock and does nothing. A held lock is skipped silently. A tick
 * never throws: an error is logged once and the next tick tries again.
 *
 * The same ticks run the periodic alarm check (`sweep`, runAlertSweep in
 * lib/server/devices/alerts.ts, passed in by instrumentation.ts) on its own busy flag, so a long
 * maintenance run never delays it and two checks never overlap in one process.
 * The check takes its own lease in alert_sweep, so replicas do not check at the
 * same time either. It also waits until all migrations are applied.
 *
 * Right after the alarm check, on the same busy flag, the tick runs the
 * notification dispatcher (`dispatch`, runNotificationDispatch in
 * lib/server/notifications/notifications.ts): also when the check was skipped by its lease or
 * failed, so new alarm events go out within about one tick. It takes its own
 * lease in notification_dispatch.
 *
 * The vulnerability check (`vulnerabilities`, runVulnerabilitySync in
 * lib/server/devices/vulnerability-sync.ts) runs on a third busy flag: one NVD sync can take
 * minutes, so it never delays the alarm check, the dispatcher or the
 * maintenance. It decides itself whether a run is due and takes its own lease
 * in vulnerability_sync; it also waits until all migrations are applied.
 *
 * The agent release check (`releases`, runRequestedReleaseCheck in
 * lib/server/agent/release-source.ts) runs on a fourth busy flag. It starts a check only
 * when an Owner selected Check now, or once on an installation that never checked; the downloads can take
 * minutes, so it never delays the other work. It takes its own lease in
 * agent_release_source (runtime/release-import.mjs) and waits until all
 * migrations are applied. The daily check itself is a step of the maintenance.
 *
 * The account check of Microsoft Entra ID (`entraCheck`, runEntraDirectoryCheck
 * in lib/server/identity/entra/directory-check.ts) runs on a fifth busy flag. It decides itself
 * whether a run is due (every 15 minutes while sign-in with Microsoft is on) and
 * takes its own lease in entra_directory_check; Graph requests can take a while,
 * so it never delays the other work. It waits until all migrations are applied.
 */

export const firstTickMs = 30_000;
export const tickMs = 60_000;
const schedulerKey = Symbol.for('serverdesk.runtime.maintenance-scheduler');

const sameDecision = (a, b) => !!a && a.trigger === b.trigger && a.slot === b.slot && a.after === b.after;

/**
 * A scheduler with an injectable clock, timers, database, storage, environment
 * and log. start() arms the timers; tick() runs one tick and resolves with the
 * outcome of the run it started, or null.
 */
export function createMaintenanceScheduler({
  database,
  storage,
  env = process.env,
  clock = Date.now,
  timers = globalThis,
  log = message => console.error(message),
  fetch = globalThis.fetch,
  journal,
  runOptions,
  sweep,
  dispatch,
  vulnerabilities,
  releases,
  entraCheck,
} = {}) {
  let busy = false, stopped = false, waitingLogged = false, lastError = null, first = null, interval = null;
  let sweeping = false, lastSweepError = null, lastDispatchError = null, checking = false, lastVulnerabilityError = null;
  let importing = false, lastReleaseError = null;
  let entraChecking = false, lastEntraCheckError = null;
  const state = { nextTickAt: null };

  const write = message => { try { log(message); } catch { /* logging never breaks a tick */ } };
  async function decide(now) {
    const settings = await readMaintenanceSettings(database);
    const slot = maintenanceSlot(now, settings.runAt, settings.timeZone);
    if (!await startedSince(database, slot)) return { trigger: 'schedule', slot, after: undefined };
    const continuation = await pendingContinuation(database);
    return continuationDue(continuation, now) ? { trigger: 'continuation', slot: undefined, after: continuation.after } : null;
  }

  async function tick() {
    if (busy || stopped) return null;
    busy = true;
    try {
      const pending = journal ? await migrationsPending(database, journal) : await migrationsPending(database);
      if (pending) {
        if (!waitingLogged) write(`ServerDesk: ${maintenanceWaitingMessage}`);
        waitingLogged = true;
        return null;
      }
      waitingLogged = false;
      const now = clock(), decision = await decide(now);
      if (!decision) { lastError = null; return null; }
      const started = await startMaintenance(database, {
        trigger: decision.trigger, storage, env, fetch, clock, timers, runOptions, ...(journal ? { journal } : {}),
        verify: async () => sameDecision(await decide(now), decision),
        notice: message => write('ServerDesk: ' + message),
      });
      lastError = null;
      if (started.status !== 'started') return null;
      return await started.finished;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== lastError) write(`ServerDesk: Maintenance scheduler error: ${message}`);
      lastError = message;
      return null;
    } finally {
      busy = false;
    }
  }

  /** The notification dispatcher after the check; never rejects. */
  async function dispatchRun() {
    if (!dispatch) return;
    try {
      await dispatch(clock());
      lastDispatchError = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== lastDispatchError) write(`ServerDesk: Notification dispatch error: ${message}`);
      lastDispatchError = message;
    }
  }

  /**
   * One run of the alarm check and then the notification dispatcher; resolves
   * with the result of the check, or null when it did not run. Never rejects.
   */
  async function sweepTick() {
    if ((!sweep && !dispatch) || sweeping || stopped) return null;
    sweeping = true;
    try {
      if (journal ? await migrationsPending(database, journal) : await migrationsPending(database)) return null;
      let result = null;
      if (sweep) {
        try {
          result = (await sweep(clock())) ?? null;
          lastSweepError = null;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message !== lastSweepError) write(`ServerDesk: Alarm check error: ${message}`);
          lastSweepError = message;
        }
      }
      await dispatchRun();
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== lastSweepError) write(`ServerDesk: Alarm check error: ${message}`);
      lastSweepError = message;
      return null;
    } finally {
      sweeping = false;
    }
  }

  /**
   * One call of the vulnerability check; resolves with its result, or null when
   * it did not run (busy, stopped, migrations pending or an error). Never rejects.
   */
  async function vulnerabilityTick() {
    if (!vulnerabilities || checking || stopped) return null;
    checking = true;
    try {
      if (journal ? await migrationsPending(database, journal) : await migrationsPending(database)) return null;
      const result = (await vulnerabilities(clock())) ?? null;
      lastVulnerabilityError = null;
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== lastVulnerabilityError) write(`ServerDesk: Vulnerability check error: ${message}`);
      lastVulnerabilityError = message;
      return null;
    } finally {
      checking = false;
    }
  }

  /**
   * One call of the requested agent release check; resolves with its result,
   * or null when it did not run (busy, stopped, migrations pending or an
   * error). Never rejects.
   */
  async function releaseTick() {
    if (!releases || importing || stopped) return null;
    importing = true;
    try {
      if (journal ? await migrationsPending(database, journal) : await migrationsPending(database)) return null;
      const result = (await releases(clock())) ?? null;
      lastReleaseError = null;
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== lastReleaseError) write(`ServerDesk: Agent release check error: ${message}`);
      lastReleaseError = message;
      return null;
    } finally {
      importing = false;
    }
  }

  /**
   * One call of the Entra account check; resolves with its result, or null when
   * it did not run (busy, stopped, migrations pending or an error). Never rejects.
   */
  async function entraCheckTick() {
    if (!entraCheck || entraChecking || stopped) return null;
    entraChecking = true;
    try {
      if (journal ? await migrationsPending(database, journal) : await migrationsPending(database)) return null;
      const result = (await entraCheck(clock())) ?? null;
      lastEntraCheckError = null;
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== lastEntraCheckError) write(`ServerDesk: Entra account check error: ${message}`);
      lastEntraCheckError = message;
      return null;
    } finally {
      entraChecking = false;
    }
  }

  const scheduled = () => { state.nextTickAt = clock() + tickMs; void tick(); void sweepTick(); void vulnerabilityTick(); void releaseTick(); void entraCheckTick(); };
  return {
    tick,
    sweepTick,
    vulnerabilityTick,
    releaseTick,
    entraCheckTick,
    /** The time of the next tick, or null before start() and after stop(). */
    get nextTickAt() { return state.nextTickAt; },
    start() {
      if (first || interval || stopped) return;
      state.nextTickAt = clock() + firstTickMs;
      first = timers.setTimeout(() => {
        first = null;
        if (stopped) return;
        interval = timers.setInterval(scheduled, tickMs);
        interval?.unref?.();
        scheduled();
      }, firstTickMs);
      first?.unref?.();
    },
    stop() {
      stopped = true;
      state.nextTickAt = null;
      if (first) timers.clearTimeout(first);
      if (interval) timers.clearInterval(interval);
      first = interval = null;
    },
  };
}

/** The scheduler of this process, or null. */
export const processScheduler = () => globalThis[schedulerKey] ?? null;

/**
 * Starts the one scheduler of this process, once. Returns it, or null without
 * DATABASE_URL or with MAINTENANCE_SCHEDULER=off.
 */
export async function ensureMaintenanceScheduler(env = process.env, options = {}) {
  if (globalThis[schedulerKey]) return globalThis[schedulerKey];
  if (!env.DATABASE_URL || String(env.MAINTENANCE_SCHEDULER ?? '').trim().toLowerCase() === 'off') return null;
  const database = options.database ?? sharedDatabase(env);
  // The object storage binding of the portal (runtime/env.mjs), shared with the routes.
  const storage = options.storage ?? (await import('./env.mjs')).env.BUCKET;
  if (globalThis[schedulerKey]) return globalThis[schedulerKey];
  const scheduler = createMaintenanceScheduler({ ...options, database, storage, env });
  globalThis[schedulerKey] = scheduler;
  scheduler.start();
  return scheduler;
}

/**
 * The next run for the settings page. While a continuation is pending: the
 * first tick at or after its due time (nextTickAt plus whole ticks), without a
 * scheduler in this process the later of the next tick and the due time. Else
 * the next slot. `nextTickAt` is the tick time of the process scheduler; tests
 * pass their own.
 */
export async function nextMaintenanceRun(database, now, settings, nextTickAt = processScheduler()?.nextTickAt ?? null) {
  const continuation = await pendingContinuation(database);
  if (continuation) {
    if (nextTickAt === null) return Math.max(now + tickMs, continuation.dueAt);
    return nextTickAt + Math.max(0, Math.ceil((continuation.dueAt - nextTickAt) / tickMs)) * tickMs;
  }
  return nextMaintenanceSlot(now, settings.runAt, settings.timeZone);
}
