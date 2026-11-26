import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// pnpm on Windows links packages with junctions. Run as Administrator it
// creates real directory symlinks with a relative target instead. Next's
// standalone copy turns those into file symlinks, and the standalone build and
// test:http then fail with EPERM. Junction targets are always absolute, so a
// relative link target identifies such a symlink without native calls.

const scriptPath = fileURLToPath(import.meta.url);
const exampleLimit = 5;
const usage = 'Usage: node scripts/check-node-modules-links.mjs [--fix]';

function entries(directory) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
    throw error;
  }
}

// Real directories only: a link is never followed into its target.
function isRealDirectory(entry) {
  return entry.isDirectory() && !entry.isSymbolicLink();
}

/** The link slots of one node_modules level: `<name>` and `@scope/<name>`. */
function linkCandidates(modulesDirectory, skip = new Set()) {
  const candidates = [];
  for (const entry of entries(modulesDirectory)) {
    if (skip.has(entry.name)) continue;
    const absolute = path.join(modulesDirectory, entry.name);
    if (entry.name.startsWith('@') && isRealDirectory(entry)) {
      for (const scoped of entries(absolute)) candidates.push(path.join(absolute, scoped.name));
    } else {
      candidates.push(absolute);
    }
  }
  return candidates;
}

/** The absolute directory a relative directory symlink points to, else null. */
function relativeDirectoryTarget(candidate) {
  let target;
  try {
    if (!fs.lstatSync(candidate).isSymbolicLink()) return null;
    target = fs.readlinkSync(candidate);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (path.isAbsolute(target)) return null;
  const resolved = path.resolve(path.dirname(candidate), target);
  try {
    return fs.statSync(resolved).isDirectory() ? resolved : null;
  } catch (error) {
    // A broken link is not this problem; pnpm install reports it on its own.
    if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) return null;
    throw error;
  }
}

function scan(root) {
  const modules = path.join(path.resolve(root), 'node_modules');
  const store = path.join(modules, '.pnpm');
  const candidates = linkCandidates(modules, new Set(['.pnpm']));
  candidates.push(...linkCandidates(path.join(store, 'node_modules')));
  for (const entry of entries(store)) {
    if (entry.name === 'node_modules' || !isRealDirectory(entry)) continue;
    candidates.push(...linkCandidates(path.join(store, entry.name, 'node_modules')));
  }
  const found = [];
  for (const candidate of candidates) {
    const target = relativeDirectoryTarget(candidate);
    if (target) found.push({ link: candidate, target });
  }
  return found.sort((left, right) => (left.link < right.link ? -1 : left.link > right.link ? 1 : 0));
}

/** Paths of all relative directory symlinks on pnpm's link levels in `<root>/node_modules`, sorted. */
export function findRelativeDirectoryLinks(root) {
  return scan(root).map(({ link }) => link);
}

/**
 * Replace every relative directory symlink with a junction to the same
 * directory and return the replaced paths. Only the link itself is moved and
 * removed; the target directory is never touched. On failure the original link
 * is restored where possible and the error carries `linkPath`.
 */
export function fixRelativeDirectoryLinks(root, fileSystem = fs) {
  const fixed = [];
  for (const { link, target } of scan(root)) {
    const parked = `${link}.sd-link-${process.pid}`;
    try {
      fileSystem.renameSync(link, parked);
      try {
        fileSystem.symlinkSync(target, link, 'junction');
      } catch (error) {
        fileSystem.renameSync(parked, link);
        throw error;
      }
      fileSystem.unlinkSync(parked);
    } catch (error) {
      error.linkPath = link;
      throw error;
    }
    fixed.push(link);
  }
  return fixed;
}

function displayPath(root, absolute) {
  return path.relative(path.resolve(root), absolute).replaceAll('\\', '/');
}

/**
 * CLI logic. Returns the exit code: 0 clean or fixed, 1 links found or fix
 * failed, 2 wrong arguments. Does nothing outside Windows.
 */
export function runCheck({ platform, root, args = [], stdout = process.stdout, stderr = process.stderr, fileSystem = fs }) {
  if (platform !== 'win32') return 0;
  if (args.some(argument => argument !== '--fix')) {
    stderr.write(`${usage}\n`);
    return 2;
  }
  if (args.includes('--fix')) {
    let fixed;
    try {
      fixed = fixRelativeDirectoryLinks(root, fileSystem);
    } catch (error) {
      if (!error.linkPath) throw error;
      stderr.write(`Could not convert ${displayPath(root, error.linkPath)} into a junction: ${error.message}. Delete node_modules and run pnpm install without administrator rights.\n`);
      return 1;
    }
    if (fixed.length) stdout.write(`Replaced ${fixed.length} directory symlinks in node_modules with junctions.\n`);
    return 0;
  }
  const links = findRelativeDirectoryLinks(root);
  if (!links.length) return 0;
  const examples = links.slice(0, exampleLimit).map(link => `  - ${displayPath(root, link)}\n`).join('');
  stderr.write(
    `node_modules contains ${links.length} relative directory symlinks instead of junctions. This happens when pnpm runs as administrator on Windows, and it makes the standalone build fail with EPERM.\n`
    + examples
    + (links.length > exampleLimit ? '  - …\n' : '')
    + 'Repair it with "node scripts/check-node-modules-links.mjs --fix", or install again without administrator rights (delete node_modules, then run pnpm install).\n',
  );
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  process.exitCode = runCheck({ platform: process.platform, root: process.cwd(), args: process.argv.slice(2) });
}
