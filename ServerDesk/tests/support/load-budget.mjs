import { performance } from 'node:perf_hooks';
import { sql } from '../../runtime/database.mjs';

// Wall-time budgets for spans with database round trips. Other test runs can
// load the shared PostgreSQL server, so a fixed budget fails without a
// regression. A budget therefore scales with a load factor: the median time
// of a fixed reference statement on the same database, divided by its time on
// an unloaded machine, clamped to [1, 4]. The span counts with the fastest of
// five runs, so one stall does not decide. The clamp limits how much load can
// hide: a span that becomes more than four times slower still fails.

// A fixed amount of server work in one round trip.
export const referenceStatement = sql`SELECT count(*) AS n FROM generate_series(1, 200000) AS i WHERE i % 7 = 3`;
// The median time of the reference statement in milliseconds on an unloaded
// machine: an idle test container (2 CPUs) on the development machine gave
// 27 ms in ten measurements of seven runs each.
export const referenceMs = 27;
export const minFactor = 1;
export const maxFactor = 4;
export const repetitions = 5;

const median = values => {
  const sorted = [...values].sort((a, b) => a - b), middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/**
 * The load factor of `database` now: the median time of `runs` reference
 * statements (after one warm-up run) divided by referenceMs, clamped to [1, 4].
 */
export async function loadFactor(database, runs = 7) {
  await database.one(referenceStatement);
  const timings = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    await database.one(referenceStatement);
    timings.push(performance.now() - start);
  }
  const referenceMedian = median(timings);
  return { factor: Math.min(maxFactor, Math.max(minFactor, referenceMedian / referenceMs)), referenceMedian };
}

/**
 * Measures the load factor of `database` just before the repetitions, then
 * runs `span(i)` five times and keeps the fastest run. `prepare(i)` runs
 * before each repetition, outside the measured time. Returns {ms, budget,
 * factor, referenceMedian, value}: the fastest time, `baseMs` times the
 * factor, and the result of the fastest run.
 */
export async function budgeted(database, baseMs, span, { prepare } = {}) {
  const { factor, referenceMedian } = await loadFactor(database);
  let ms = Infinity, value;
  for (let i = 0; i < repetitions; i++) {
    if (prepare) await prepare(i);
    const start = performance.now();
    const result = await span(i);
    const elapsed = performance.now() - start;
    if (elapsed < ms) { ms = elapsed; value = result; }
  }
  return { ms, budget: baseMs * factor, factor, referenceMedian, value };
}

/** The log text of one budget: the fastest time, the factor and the budget. */
export const budgetText = ({ ms, factor, budget }) => `fastest of ${repetitions} ${Math.round(ms)} ms, load factor ${factor.toFixed(2)}, budget ${Math.round(budget)} ms`;
