// The start of the shared test PostgreSQL in tests/support/postgres.mjs, driven
// by a fake docker instead of a real one: "already in use", a created container
// that is not running yet and a running one without its port all end in the
// address; parallel callers get the same address from one docker run; a
// container that never gets ready fails after the deadline with the "No
// PostgreSQL for the tests" text and the last Docker state; TEST_DATABASE_URL
// never calls docker.
import assert from 'node:assert/strict';
import { adminAddress, containerName, image, startContainer } from '../support/postgres.mjs';

let checks = 0;
const check = (condition, label) => { assert.ok(condition, label); checks++; };
const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
const fail = stderr => ({ status: 1, stdout: '', stderr });
const inspectOutput = (status, password = 'secret') => ok(`${status}|${status === 'running'}|PATH=/usr/bin\nPOSTGRES_PASSWORD=${password}\n`);
const noSuchObject = fail(`Error: No such object: ${containerName}\n`);
const inUse = fail(`docker: Error response from daemon: Conflict. The container name "/${containerName}" is already in use by container "abc". You have to remove (or rename) that container to be able to reuse that name.\n`);

/** A fake clock: sleep moves the time on at once. */
function clock() {
  let time = 1_000_000;
  const sleeps = [];
  return { now: () => time, sleep: async ms => { sleeps.push(ms); time += ms; await new Promise(resolve => setImmediate(resolve)); }, sleeps };
}

// 1. One process: its docker run loses against another process ("already in
// use"), then it finds the container created but not running, then running
// without its port, then ready.
{
  const phases = ['missing', 'created', 'running', 'running', 'ready'];
  const calls = [];
  let phase = 0;
  const docker = async args => {
    calls.push(args[0]);
    if (args[0] === 'version') return ok('29.4.2\n');
    if (args[0] === 'inspect') {
      const current = phases[Math.min(phase++, phases.length - 1)];
      return current === 'missing' ? noSuchObject : inspectOutput(current === 'created' ? 'created' : 'running');
    }
    if (args[0] === 'run') return inUse;
    if (args[0] === 'start') return ok(`${containerName}\n`);
    if (args[0] === 'port') return phases[phase - 1] === 'ready' ? ok('127.0.0.1:55432\n') : ok('');
    throw new Error(`unexpected docker ${args.join(' ')}`);
  };
  const time = clock();
  const address = await startContainer({ docker, now: time.now, sleep: time.sleep, deadlineMs: 120_000, pollMs: 500 });
  assert.deepEqual(address, { url: 'postgres://postgres@127.0.0.1:55432/postgres', password: 'secret' }); checks++;
  check(calls.includes('run') && calls.includes('start'), `it tried docker run, then started the created container: ${calls.join(', ')}`);
  check(time.sleeps.length >= 3 && time.sleeps.every(ms => ms === 500), `it waited between the rounds: ${time.sleeps.join(', ')}`);
}

// 2. Parallel callers on a machine without container and image: one docker run
// creates it (and pulls the image), the others get "already in use" or find it
// created, not running or without the port, and all get the same address.
{
  let tick = 0, createdAt = null, runs = 0, successfulRuns = 0;
  const startedAfter = 6, publishedAfter = 12, password = 'parallel-secret';
  const docker = async args => {
    // Every docker call takes a turn of the event loop, so the callers interleave.
    await new Promise(resolve => setImmediate(resolve));
    tick++;
    if (args[0] === 'version') return ok('29.4.2\n');
    if (args[0] === 'inspect') {
      if (createdAt === null) return noSuchObject;
      return inspectOutput(tick - createdAt >= startedAfter ? 'running' : 'created', password);
    }
    if (args[0] === 'run') {
      runs++;
      assert.ok(args.includes(image) && args.includes('127.0.0.1::5432') && args.some(value => value.startsWith('POSTGRES_PASSWORD=')), 'docker run names the image, a local port and a password');
      // Each docker run pulls the missing image first, which takes a while;
      // the name is taken only when the container is created after the pull.
      if (createdAt === null) for (let turn = 0; turn < 20; turn++) await new Promise(resolve => setImmediate(resolve));
      if (createdAt !== null) return inUse;
      createdAt = tick;
      successfulRuns++;
      return ok('abc\n');
    }
    if (args[0] === 'start') return createdAt === null ? fail(`Error response from daemon: No such container: ${containerName}`) : ok(`${containerName}\n`);
    if (args[0] === 'port') return createdAt !== null && tick - createdAt >= publishedAfter ? ok('127.0.0.1:49153\n[::1]:49153\n') : ok('');
    throw new Error(`unexpected docker ${args.join(' ')}`);
  };
  const addresses = await Promise.all(Array.from({ length: 6 }, () => startContainer({ docker, pollMs: 1, deadlineMs: 120_000 })));
  check(addresses.every(address => address.url === 'postgres://postgres@127.0.0.1:49153/postgres' && address.password === password), `all callers get the same address: ${JSON.stringify(addresses)}`);
  check(successfulRuns === 1, `exactly one docker run created the container (${runs} tried)`);
}

// 3. A container that never gets ready fails after the deadline with the
// known text and the last Docker state; so does a docker run that keeps failing.
{
  const time = clock();
  const docker = async args => args[0] === 'version' ? ok('29.4.2\n') : args[0] === 'inspect' ? inspectOutput('running') : args[0] === 'port' ? ok('') : fail('unexpected');
  await assert.rejects(startContainer({ docker, now: time.now, sleep: time.sleep, deadlineMs: 3_000, pollMs: 500 }), error => {
    check(error.message.startsWith('No PostgreSQL for the tests. Set TEST_DATABASE_URL'), error.message);
    check(error.message.includes(`the container ${containerName} did not start within 3 s; last Docker state: container running, port 5432 not published yet`), error.message);
    return true;
  });
  check(time.sleeps.length === 6, `it polled until the deadline: ${time.sleeps.length} waits`);

  const pulls = clock();
  const pullFails = async args => args[0] === 'version' ? ok('29.4.2\n') : args[0] === 'inspect' ? noSuchObject : args[0] === 'run' ? fail(`Unable to find image '${image}' locally\ndocker: Error response from daemon: toomanyrequests: You have reached your pull rate limit.\n`) : fail('unexpected');
  await assert.rejects(startContainer({ docker: pullFails, now: pulls.now, sleep: pulls.sleep, deadlineMs: 2_000, pollMs: 500 }), error => {
    check(error.message.startsWith('No PostgreSQL for the tests.') && error.message.includes(`last Docker state: docker run: Unable to find image '${image}' locally`), error.message);
    return true;
  });

  const stopped = clock();
  const neverStarts = async args => args[0] === 'version' ? ok('29.4.2\n') : args[0] === 'inspect' ? inspectOutput('exited') : args[0] === 'start' ? fail('Error response from daemon: driver failed programming external connectivity\n') : fail('unexpected');
  await assert.rejects(startContainer({ docker: neverStarts, now: stopped.now, sleep: stopped.sleep, deadlineMs: 1_000, pollMs: 500 }), error => {
    check(error.message.includes('last Docker state: container exited, docker start: Error response from daemon: driver failed programming external connectivity'), error.message);
    return true;
  });

  // Without a Docker daemon there is nothing to wait for.
  let calls = 0;
  await assert.rejects(startContainer({ docker: async () => { calls++; return { status: null, stdout: '', stderr: 'spawn docker ENOENT' }; }, deadlineMs: 120_000 }), /^Error: No PostgreSQL for the tests\..*\(docker: spawn docker ENOENT\)$/);
  check(calls === 1, 'a missing docker fails at once');
}

// 4. TEST_DATABASE_URL bypasses Docker completely.
{
  const docker = () => { throw new Error('docker must not run with TEST_DATABASE_URL'); };
  const address = await adminAddress({ env: { TEST_DATABASE_URL: 'postgres://admin:p%40ss@db.test:5433/postgres' }, docker });
  assert.deepEqual(address, { url: 'postgres://admin@db.test:5433/postgres', password: 'p@ss' }); checks++;
}

console.log(`${checks} test PostgreSQL start checks passed.`);
