import { cp, readdir, rm, rmdir, stat, symlink, unlink } from 'node:fs/promises';
import path from 'node:path';

// The throwaway copy of the ServerDesk working tree for pnpm test:http
// (scripts/http-test.mjs): uncommitted changes included, without local data and
// build output, with a link to the existing node_modules. The working tree is
// never changed.

// Never copied, only at the top of ServerDesk/: local data and build output,
// plus checkout-local tool state that .gitignore and .dockerignore also leave
// out (the pnpm store under .build/ alone is about 1 GB).
const excludedTopLevel = new Set([
  '.data', 'certificates', 'coverage', 'test-results',
  '.build', '.agents', '.codex', '.openai', '.vinext', '.vercel', 'outputs', 'work', 'build', 'out', 'dist',
]);
// Fallback parent of the copy next to ServerDesk/, see temporaryParent().
export const fallbackDirectory = '.http-test-copy';
// Never copied at any depth.
const excludedEverywhere = new Set(['node_modules', '.next']);

/** The production build commands of the package.json script "build", run with the current Node binary. */
export const commands = {
  build: [
    ['scripts/check-node-modules-links.mjs'],
    ['node_modules/next/dist/bin/next', 'build', '--webpack'],
  ],
};
const binaries = { 'node_modules/typescript/bin/tsc': 'tsc', 'node_modules/next/dist/bin/next': 'next' };

/** The package.json form of a command list, so a test keeps both in sync. */
export function packageScript(list) {
  return list.map(([file, ...args]) => [binaries[file] ?? `node ${file}`, ...args].join(' ')).join(' && ');
}

/** Whether a path relative to the ServerDesk root belongs into the copy. */
export function includedInCopy(relative) {
  if (!relative) return true;
  const parts = relative.split(/[\\/]/);
  const name = parts[parts.length - 1];
  if (excludedTopLevel.has(parts[0])) return false;
  if (parts.some(part => excludedEverywhere.has(part))) return false;
  if (name.startsWith('.env') || name.endsWith('.tsbuildinfo')) return false;
  return true;
}

/**
 * Copy the ServerDesk working tree, uncommitted changes included, into
 * `target` without local data and build output. `target/node_modules` then
 * links to `source/node_modules`: a junction on Windows, so the node_modules
 * link check does not flag it, and a directory symlink elsewhere.
 */
export async function copyProductTree(source, target) {
  const from = path.resolve(source);
  const to = path.resolve(target);
  const modules = path.join(from, 'node_modules');
  if (!(await stat(modules).catch(() => null))?.isDirectory()) throw new Error(`${modules} is missing. Run pnpm install first.`);
  await cp(from, to, { recursive: true, errorOnExist: true, force: false, filter: file => includedInCopy(path.relative(from, file)) });
  await symlink(modules, path.join(to, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
}

/**
 * The directory that receives the copy. Normally os.tmpdir(). On Windows the
 * copy must sit on the drive of the linked node_modules: Next builds its client
 * entries from a relative path, and across drives that path stays absolute and
 * the build fails. Then the copy goes next to ServerDesk/ into
 * `.http-test-copy/`, outside the tsconfig, lint, Docker and Next scope. Under
 * ServerDesk/ itself Next would pick the original pnpm-workspace.yaml as the
 * workspace root.
 */
export function temporaryParent(root, tmpdir, platform = process.platform) {
  if (platform !== 'win32') return tmpdir;
  const drive = value => path.win32.parse(path.win32.resolve(value)).root.toLowerCase();
  return drive(root) === drive(tmpdir) ? tmpdir : path.win32.join(path.win32.dirname(path.win32.resolve(root)), fallbackDirectory);
}

/**
 * Remove every symlink and junction below `directory` without following it.
 * A recursive delete then cannot reach the linked node_modules of the source.
 */
async function unlinkLinks(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return;
    throw error;
  }
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) await unlink(absolute);
    else if (entry.isDirectory()) await unlinkLinks(absolute);
  }
}

export async function removeTemporary(temporary, stderr) {
  try {
    await unlinkLinks(temporary);
    await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    stderr.write(`Could not delete the temporary copy ${temporary}. Delete it manually.\n`);
    return;
  }
  // The fallback parent goes away with its last copy; os.tmpdir() stays. Windows
  // may still hold the removed copy as "delete pending" for a moment, and a
  // parallel run may still use the parent, so a few failed tries are fine.
  if (path.basename(path.dirname(temporary)) !== fallbackDirectory) return;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await rmdir(path.dirname(temporary));
      return;
    } catch (error) {
      if (error.code === 'ENOENT') return;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
}
