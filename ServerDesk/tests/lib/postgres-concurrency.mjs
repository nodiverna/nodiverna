// Real interleavings on two connections: each first transaction stops at a
// barrier inside its callback while the second one runs. SERIALIZABLE with
// retries (runtime/database.mjs) and the guards and triggers keep the outcome
// serial, like a single writer would.
import '../support/register.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase, sql } from '../../runtime/database.mjs';
import { sourceDatabase, sourceActor } from '../support/source-database.mjs';

const { dbFailure, dbTriggerCode } = await import('../../lib/server/errors/db-codes.ts');
const { globalPermissionGuard, remainingOwnerGuard } = await import('../../lib/server/identity/access.ts');
const d = await sourceDatabase();
const other = createDatabase({ url: d.url, password: d.password, max: 2, idleTimeoutSeconds: 1 });
const defaultCustomer = '00000000-0000-4000-8000-000000000100';
const at = Date.now();
let checks = 0;
const check = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };
const settle = promise => promise.then(value => ({ ok: true, value }), error => ({ ok: false, error }));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// Runs `first` on d with a barrier after its first statement, then `second` on
// the other connection, then lets `first` finish. The second may block on a
// row lock of the first; the first commits after a short wait either way.
async function interleave(first, second) {
  let reached, attempt = 0;
  const atBarrier = new Promise(resolve => { reached = resolve; });
  const one = settle(d.transaction(async tx => {
    attempt++;
    const result = await first(tx);
    if (attempt === 1) { reached(); await pause(250); }
    return result;
  }));
  await atBarrier;
  const two = settle(other.transaction(second));
  return [await one, await two];
}

try {
  // (a) A guarded grant against a concurrent demotion of the grantor.
  {
    const { actor: grantor, assignmentId } = await sourceActor(d, 'grantor@race.test', ['portal.roleAssignments.manage']);
    const { actor: recipient } = await sourceActor(d, 'recipient@race.test', []);
    const roleId = randomUUID();
    await d.exec(sql`INSERT INTO rbac_roles(id,name,description,permissions,builtin,created_at) VALUES(${roleId},'Race role','','["view"]',0,${at})`);
    const guard = globalPermissionGuard(sql`${grantor.principal}`, 'portal.roleAssignments.manage'), grant = randomUUID();
    const [granted, demoted] = await interleave(
      async tx => {
        const inserted = await tx.exec(sql`INSERT INTO role_assignments(id,principal_type,principal_id,role_id,scope_type,scope_id,created_at,created_by) SELECT ${grant},'user',${recipient.id},${roleId},'global','*',${at},${grantor.principal} WHERE ${guard}`);
        if (inserted.rowCount) await tx.exec(sql`INSERT INTO audit(at,actor,action,target) VALUES(${at},${grantor.label},'Race grant',${grant})`);
        return inserted.rowCount;
      },
      tx => tx.exec(sql`DELETE FROM role_assignments WHERE id=${assignmentId}`),
    );
    check([granted.ok, demoted.ok], [true, true], '(a) both transactions commit or retry to a serial result');
    const rows = Number((await d.one(sql`SELECT count(*) AS n FROM role_assignments WHERE id=${grant}`)).n), audits = Number((await d.one(sql`SELECT count(*) AS n FROM audit WHERE target=${grant}`)).n);
    check(rows, audits, '(a) the grant exists exactly when its audit row exists');
    check(await d.one(sql`SELECT id FROM role_assignments WHERE id=${assignmentId}`), null, '(a) the demotion committed');
  }

  // (b) Concurrent parent_id updates A->B and B->A: exactly one commits.
  {
    const a = randomUUID(), b = randomUUID();
    for (const [id, name] of [[a, 'Race A'], [b, 'Race B']]) await d.exec(sql`INSERT INTO device_groups(id,name,created_at,customer_id) VALUES(${id},${name},${at},${defaultCustomer})`);
    const [first, second] = await interleave(
      tx => tx.exec(sql`UPDATE device_groups SET parent_id=${b} WHERE id=${a}`),
      tx => tx.exec(sql`UPDATE device_groups SET parent_id=${a} WHERE id=${b}`),
    );
    check([first.ok, second.ok].filter(Boolean).length, 1, '(b) exactly one parent change commits');
    const failed = first.ok ? second.error : first.error;
    check([dbTriggerCode(failed), dbFailure(failed)?.code], ['device-group-cycle', 'DEVICE_GROUP_CYCLE'], '(b) the other fails with device-group-cycle');
  }

  // (c) Two concurrent enrollments on an installer with max_devices=1.
  {
    const installer = randomUUID();
    await d.exec(sql`INSERT INTO customer_installers(id,customer_id,name,key_hash,mode,expires_at,max_devices,enrollments,created_at,created_by) VALUES(${installer},${defaultCustomer},'Race installer',${randomUUID()},'ReadOnly',${at + 86_400_000},1,0,${at},'race')`);
    const enroll = tx => tx.exec(sql`UPDATE customer_installers SET enrollments=enrollments+1 WHERE id=${installer} AND revoked_at IS NULL`);
    const [first, second] = await interleave(enroll, enroll);
    check([first.ok, second.ok].filter(Boolean).length, 1, '(c) exactly one enrollment commits');
    check(dbFailure(first.ok ? second.error : first.error)?.code, 'INSTALLER_EXHAUSTED', '(c) the other gets INSTALLER_EXHAUSTED');
    check((await d.one(sql`SELECT enrollments FROM customer_installers WHERE id=${installer}`)).enrollments, 1, '(c) the counter stays at the limit');
  }

  // (d) One device joins a group and its ancestor at the same time.
  {
    const parent = randomUUID(), child = randomUUID(), device = randomUUID();
    await d.exec(sql`INSERT INTO device_groups(id,name,created_at,customer_id) VALUES(${parent},'Race parent',${at},${defaultCustomer})`);
    await d.exec(sql`INSERT INTO device_groups(id,name,created_at,parent_id,customer_id) VALUES(${child},'Race child',${at},${parent},${defaultCustomer})`);
    await d.exec(sql`INSERT INTO servers(id,name,token_hash,created_at,customer_id) VALUES(${device},'Race device',${randomUUID()},${at},${defaultCustomer})`);
    const [first, second] = await interleave(
      tx => tx.exec(sql`INSERT INTO device_group_members(server_id,group_id) VALUES(${device},${child})`),
      tx => tx.exec(sql`INSERT INTO device_group_members(server_id,group_id) VALUES(${device},${parent})`),
    );
    check([first.ok, second.ok].filter(Boolean).length, 1, '(d) exactly one membership commits');
    const code = dbFailure(first.ok ? second.error : first.error)?.code;
    check(['DEVICE_GROUP_MEMBERSHIP_PATH_CONFLICT', 'DEVICE_GROUP_MEMBERSHIP_TAKEN'].includes(code), true, `(d) the other fails with a membership conflict (${code})`);
  }

  // (e) Two Owners remove each other's Owner assignment at the same time.
  {
    await d.exec(sql`DELETE FROM role_assignments WHERE scope_type='global' AND role_id IN (SELECT id FROM rbac_roles WHERE permissions LIKE '%"*"%')`);
    const one = await sourceActor(d, 'owner-one@race.test', ['*']), two = await sourceActor(d, 'owner-two@race.test', ['*']);
    const remove = target => tx => tx.exec(sql`DELETE FROM role_assignments WHERE id=${target} AND ${remainingOwnerGuard(null, target)}`);
    await interleave(remove(two.assignmentId), remove(one.assignmentId));
    const remaining = Number((await d.one(sql`SELECT count(*) AS n FROM role_assignments WHERE id IN (${one.assignmentId},${two.assignmentId})`)).n);
    check(remaining >= 1, true, '(e) at least one active global Owner remains');
  }
  console.log(`PASS ${checks} concurrency checks: guarded grant vs demotion, parent cycle, installer limit, membership path, last Owner.`);
} finally {
  await other.close();
  await d.close();
}
