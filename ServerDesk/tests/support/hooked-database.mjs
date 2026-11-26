import { AsyncLocalStorage } from 'node:async_hooks';
import { compile } from '../../runtime/database.mjs';

// Race tests interleave a concurrent change at an exact point of a request. A
// hooked database runs these hooks (all may be async, all can be replaced or
// cleared through `hooks`):
//   statement(text, kind, inTransaction)  before each statement
//   after(text, inTransaction, result)     after each statement
//   transaction()                          before each transaction starts
//   batch(texts)                           before each transaction starts, with
//                                          the statement texts the transaction
//                                          will run (read in a dry run that is
//                                          rolled back), so a change can land
//                                          right before a matching transaction
// With `hooks.record` (an array), each transaction appends the list of its
// statement texts. With `hooks.results` (an array), each committed transaction
// appends {text, rowCount} per statement (rows of SELECT or RETURNING, the
// row count of exec). Both hold the last attempt when a transaction retries. Hooks run outside the transaction's async context, so they
// may use the plain database (another connection). The hooked database becomes
// this process's shared database, so lib/server/db.ts db() returns it.
const sharedKey = Symbol.for('serverdesk.runtime.database');
const outside = AsyncLocalStorage.bind(callback => callback());
const dryRun = Symbol('dry run');

export function hookDatabase(database, hooks = {}) {
  const state = { statement: hooks.statement ?? null, after: hooks.after ?? null, transaction: hooks.transaction ?? null, batch: hooks.batch ?? null, record: hooks.record ?? null, results: hooks.results ?? null };
  const rowCount = (kind, result) => kind === 'exec' ? result.rowCount : kind === 'query' ? result.length : result === null ? 0 : 1;
  const wrap = (target, inTransaction, log = null, quiet = false, results = null) => {
    const run = async (statement, kind) => {
      const { text } = compile(statement);
      log?.push(text);
      if (!quiet && state.statement) await outside(() => state.statement(text, kind, inTransaction));
      const result = await target[kind](statement);
      results?.push({ text, rowCount: rowCount(kind, result) });
      if (!quiet && state.after) await outside(() => state.after(text, inTransaction, result));
      return result;
    };
    return {
      query: statement => run(statement, 'query'),
      one: statement => run(statement, 'one'),
      exec: statement => run(statement, 'exec'),
    };
  };
  const hooked = {
    ...wrap(database, false),
    async transaction(callback, options) {
      if (state.transaction) await outside(() => state.transaction());
      if (state.batch) {
        const texts = [];
        await database.transaction(async tx => { await callback(wrap(tx, true, texts, true)); throw dryRun; }, options).catch(() => {});
        await outside(() => state.batch(texts));
      }
      const log = state.record ? [] : null;
      if (log) state.record.push(log);
      let results = null;
      const value = await database.transaction(tx => {
        if (log) log.length = 0;
        results = state.results ? [] : null;
        return callback(wrap(tx, true, log, false, results));
      }, options);
      if (results) state.results.push(results);
      return value;
    },
    close: () => database.close(),
    hooks: state,
    /** Runs `hook` once, before the next transaction starts. */
    beforeNextTransaction(hook) {
      state.transaction = async () => { state.transaction = null; await hook(); };
    },
    /** Runs `hook` once, before the next statement whose text matches `pattern`. */
    beforeNextStatement(pattern, hook) {
      const previous = state.statement;
      state.statement = async (text, kind, inTransaction) => {
        if (pattern.test(text)) { state.statement = previous; await hook(text); return; }
        if (previous) await previous(text, kind, inTransaction);
      };
    },
  };
  globalThis[sharedKey] = hooked;
  return hooked;
}
