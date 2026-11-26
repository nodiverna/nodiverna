// The job actor principal migration (drizzle/<n>_job_actor_principal.sql, job
// 232): jobs stored before it get actor_principal = the auth_principal of the
// account whose auth_email is the job's actor_email (an Entra ID account gives
// entra:<tid>:<oid>), else 'private:' || actor_email. Jobs without
// actor_email keep NULL. The CHECK jobs_actor_principal pairs both columns.
// The migrations before it stay unchanged.
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sql } from '../../runtime/database.mjs';
import { migrateDatabase } from '../../scripts/selfhost.mjs';
import { testDatabase } from '../support/postgres.mjs';

const shipped = fileURLToPath(new URL('../../drizzle/', import.meta.url));
const at = Date.UTC(2031, 0, 1);
const tenant = '7c7c7c7c-0000-4000-8000-000000000232', oid = '0b0b0b0b-0000-4000-8000-000000000232';
const entraPrincipal = `entra:${tenant}:${oid}`, entraLabel = `${oid}@${tenant}.entra.serverdesk.invalid`;

/** An empty database migrated with the shipped migrations before the principal migration; then it is added to the directory. */
async function beforePrincipal(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'serverdesk-job-actor-principal-'));
  const database = await testDatabase({ template: false });
  try {
    const files = (await readdir(shipped)).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort();
    const migration = files.find(name => /^\d{4}_job_actor_principal\.sql$/.test(name));
    assert.ok(migration, 'the job actor principal migration is shipped');
    const earlier = files.filter(name => name < migration);
    for (const name of earlier) await copyFile(path.join(shipped, name), path.join(directory, name));
    assert.deepEqual(await migrateDatabase(database, { directory }), { applied: earlier.length, total: earlier.length });
    const addMigration = () => copyFile(path.join(shipped, migration), path.join(directory, migration));
    return await run({ database, directory, addMigration, total: earlier.length + 1 });
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

const job = (id, actorEmail) =>
  sql`INSERT INTO jobs(id,server_id,action,target,state,created_at,actor,parameters,actor_email) VALUES(${id},'device-1','refresh','','pending',${at},'fixture','{}',${actorEmail})`;

test('jobs stored before the migration get the principal of their account, else private:<email>; the CHECK pairs both columns', async () => {
  await beforePrincipal(async ({ database, directory, addMigration, total }) => {
    await database.exec(sql`INSERT INTO servers(id,name,token_hash,created_at) VALUES('device-1','Device 1','token-1',${at})`);
    await database.exec(sql`INSERT INTO local_users(id,username,email,display_name,auth_principal,auth_email,status,auth_version,created_at,updated_at,password_hash,must_reset) VALUES('user-local','local','local@jobs.test','Local','private:local@jobs.test','local@jobs.test','active',1,${at},${at},'fixture',0)`);
    await database.exec(sql`INSERT INTO local_users(id,username,email,display_name,auth_principal,auth_email,status,auth_version,created_at,updated_at,password_hash,must_reset,identity_source,entra_tenant_id,entra_object_id) VALUES('user-entra','entra.operator','operator@contoso.test','Operator',${entraPrincipal},${entraLabel},'active',1,${at},${at},NULL,0,'entra',${tenant},${oid})`);
    await database.exec(job('job-local', 'local@jobs.test'));
    await database.exec(job('job-entra', entraLabel));
    await database.exec(job('job-unknown', 'gone@jobs.test'));
    await database.exec(job('job-system', null));
    await addMigration();
    assert.deepEqual(await migrateDatabase(database, { directory }), { applied: 1, total });

    const rows = await database.query(sql`SELECT id,actor_email,actor_principal FROM jobs ORDER BY id`);
    assert.deepEqual(rows.map(row => [row.id, row.actor_principal]), [
      ['job-entra', entraPrincipal],
      ['job-local', 'private:local@jobs.test'],
      ['job-system', null],
      ['job-unknown', 'private:gone@jobs.test'],
    ], 'the backfill takes the account principal, else private:<email>, and keeps NULL without actor_email');
    assert.deepEqual(rows.find(row => row.id === 'job-entra').actor_email, entraLabel, 'actor_email keeps the label');

    const column = await database.one(sql`SELECT data_type,is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='jobs' AND column_name='actor_principal'`);
    assert.deepEqual(column, { data_type: 'text', is_nullable: 'YES' }, 'actor_principal is nullable text');

    const refused = async (statement, label) => {
      await assert.rejects(database.exec(statement), error => error.code === '23514' && /jobs_actor_principal/.test(error.message), label);
    };
    await refused(sql`INSERT INTO jobs(id,server_id,action,target,state,created_at,actor,parameters,actor_email) VALUES('job-half','device-1','refresh','','pending',${at},'fixture','{}','local@jobs.test')`, 'actor_email without actor_principal is refused');
    await refused(sql`INSERT INTO jobs(id,server_id,action,target,state,created_at,actor,parameters,actor_principal) VALUES('job-half','device-1','refresh','','pending',${at},'fixture','{}','private:local@jobs.test')`, 'actor_principal without actor_email is refused');
    await refused(sql`UPDATE jobs SET actor_principal=NULL WHERE id='job-local'`, 'clearing the principal of a job with an actor is refused');
    await database.exec(sql`INSERT INTO jobs(id,server_id,action,target,state,created_at,actor,parameters,actor_email,actor_principal) VALUES('job-both','device-1','refresh','','pending',${at},'fixture','{}','local@jobs.test','private:local@jobs.test')`);
    assert.equal((await database.one(sql`SELECT actor_principal FROM jobs WHERE id='job-both'`)).actor_principal, 'private:local@jobs.test', 'a job with both columns is stored');
  });
});
