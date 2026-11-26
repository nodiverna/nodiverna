// The runtime/*.mjs module of an import text, for tests that compile project files with a hand-written
// require. Files in lib/server/ import runtime modules relatively ('../../runtime/database.mjs', one step
// more from a domain folder), and a require relative to tests/ cannot resolve that text.
// runtimePath(id) gives the absolute path of such a module, and any other id unchanged.
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const runtimeDir = fileURLToPath(new URL('../../runtime/', import.meta.url));

export function runtimePath(id) {
  const match = typeof id === 'string' ? /^(?:\.\.\/)+runtime\/([\w.-]+\.mjs)$/.exec(id) : null;
  return match ? path.join(runtimeDir, match[1]) : id;
}
