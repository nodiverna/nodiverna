#!/usr/bin/env node
/**
 * Writes drizzle/schema.lock.sql, the schema after all migrations:
 *
 *   pnpm db:schema-lock
 *
 * Migrates a fresh, empty PostgreSQL database of the test server
 * (tests/support/postgres.mjs: TEST_DATABASE_URL or the Docker container) from
 * drizzle/ and writes schemaLock(): tables, indexes, views, functions and
 * triggers from the catalog, sorted, with LF line ends.
 * Every new migration commits an updated lock; tests/repo/selfhost-safe-migrations.mjs
 * fails while the file and the migrated schema differ.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase } from '../runtime/database.mjs';
import { createTestDatabase } from '../tests/support/postgres.mjs';
import { migrateDatabase, schemaLock, schemaLockObjects } from './selfhost.mjs';

const lockFile = fileURLToPath(new URL('../drizzle/schema.lock.sql', import.meta.url));

async function main() {
  const target = await createTestDatabase({ template: false });
  const database = createDatabase({ url: target.url, password: target.password, max: 2, idleTimeoutSeconds: 1 });
  try {
    await migrateDatabase(database);
    const text = await schemaLock(database);
    const count = (await schemaLockObjects(database)).length;
    const current = await readFile(lockFile, 'utf8').catch(error => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    // An unchanged schema leaves the file untouched.
    if (current !== text) await writeFile(lockFile, text);
    console.log(`Schema lock written: ${path.relative(process.cwd(), lockFile) || lockFile} (${count} objects)`);
  } finally {
    await database.close();
    await target.drop();
  }
}

main().catch(error => {
  console.error('ServerDesk: ' + (error instanceof Error ? error.message : 'Schema lock failed.'));
  process.exitCode = 1;
});
