import { createDatabase, sql } from '../../runtime/database.mjs';

// Drops the test databases that a failing test process still holds. The exit
// handler of tests/support/postgres.mjs runs this file as a short child
// process, because an exit handler cannot wait for a promise. The admin
// address and the names come in SD_DROP_URL, SD_DROP_PASSWORD and
// SD_DROP_NAMES (a JSON array).
const admin = createDatabase({ url: process.env.SD_DROP_URL, password: process.env.SD_DROP_PASSWORD, max: 1, connectTimeoutMs: 2000, idleTimeoutSeconds: 1 });
try {
  for (const name of JSON.parse(process.env.SD_DROP_NAMES ?? '[]')) {
    if (typeof name === 'string' && name.startsWith('sd_t_')) await admin.exec(sql`DROP DATABASE IF EXISTS ${sql.ident(name)} WITH (FORCE)`).catch(() => {});
  }
} finally {
  await admin.close();
}
