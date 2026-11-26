import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { commands, copyProductTree, removeTemporary, temporaryParent } from './copy-tree.mjs';
import { testPublisherCopyVariable } from './test-publisher.mjs';

// pnpm test:http: the HTTP integration test on a production build that trusts
// a throwaway test publisher, so the signed update path runs end to end without
// the production key. The script copies the working tree (uncommitted changes
// included, with linked node_modules, scripts/copy-tree.mjs), creates a
// test key outside the copy, pins it in the copy (scripts/test-publisher.mjs
// pin, with SERVERDESK_TEST_PUBLISHER_COPY naming the copy), builds the copy
// and runs the test file there with SERVERDESK_TEST_PUBLISHER_KEY_FILE. The
// copy and the key are always removed; the working tree is never changed.

const scriptPath = fileURLToPath(import.meta.url);
export const usage = 'Usage: node scripts/http-test.mjs tests/integration/<name>.mjs';
const testFile = /^tests\/integration\/[A-Za-z0-9][A-Za-z0-9-]*\.mjs$/;
const failures = {
  copy: 'Could not create the temporary copy',
  pin: 'The test publisher could not be pinned in the temporary copy. The errors are shown above.',
  build: 'The production build of the test-pinned copy failed. The errors are shown above.',
  test: 'The HTTP integration test failed. The errors are shown above.',
};

class CommandFailed extends Error {}

function runCommand(cwd, [file, ...args], env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], { cwd, stdio: 'inherit', env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', ...env } });
    child.on('error', reject);
    child.on('exit', (code, signal) => (code === 0 ? resolve() : reject(new CommandFailed(`${file} ended with ${signal ?? `exit code ${code}`}.`))));
  });
}

export const defaultSteps = {
  copy: ({ root, cwd }) => copyProductTree(root, cwd),
  // The copy may sit inside the git work tree (Windows: .http-test-copy/), so it is marked as the throwaway copy.
  pin: ({ cwd, key }) => runCommand(cwd, ['scripts/test-publisher.mjs', 'pin', '--key', key], { [testPublisherCopyVariable]: cwd }),
  build: async ({ cwd }) => { for (const command of commands.build) await runCommand(cwd, command); },
  test: ({ cwd, key, file }) => runCommand(cwd, [file], { SERVERDESK_TEST_PUBLISHER_KEY_FILE: key }),
};

/**
 * CLI logic. Returns the exit code: 0 the test passed, 1 a step failed, 2 wrong
 * arguments. `steps` replaces the expensive steps in tests; `tmpdir` defaults to
 * os.tmpdir() (see temporaryParent() in scripts/copy-tree.mjs).
 */
export async function runHttpTest({ root, args = [], stdout = process.stdout, stderr = process.stderr, steps = {}, tmpdir = os.tmpdir() }) {
  if (args.length !== 1 || !testFile.test(args[0]) || !existsSync(path.join(root, args[0]))) {
    stderr.write(`${usage}\n`);
    return 2;
  }
  const run = { ...defaultSteps, ...steps };
  const parent = temporaryParent(root, tmpdir);
  await mkdir(parent, { recursive: true });
  const temporary = await mkdtemp(path.join(parent, 'serverdesk-http-'));
  const context = { root: path.resolve(root), cwd: path.join(temporary, 'ServerDesk'), key: path.join(temporary, 'test-publisher-private.pem'), file: args[0], stdout, stderr };
  let code = 0;
  try {
    for (const step of ['copy', 'pin', 'build', 'test']) {
      try {
        await run[step](context);
      } catch (error) {
        stderr.write(step === 'copy' ? `${failures.copy} ${context.cwd}: ${error.message}\n` : `${error instanceof CommandFailed ? '' : `${error.message}\n`}${failures[step]}\n`);
        code = 1;
        break;
      }
    }
    if (!code) stdout.write(`The HTTP integration test passed on a build that trusts a throwaway test publisher.\n`);
  } finally {
    // The key lives next to the copy, so this removes both.
    await rm(context.key, { force: true }).catch(() => {});
    await removeTemporary(temporary, stderr);
  }
  return code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  process.exitCode = await runHttpTest({ root: process.cwd(), args: process.argv.slice(2) });
}
