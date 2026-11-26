// The two roots that tests read from, computed once from this file's place
// (tests/support/). A test imports them from here instead of computing a root
// from its own place, so moving a test to another folder changes only its
// relative imports, which fail loudly. Both paths are absolute and end with the
// path separator, as fileURLToPath(new URL('..', import.meta.url)) gave them.
//   serverDeskRoot  ServerDesk/
//   repositoryRoot  the repository root (the parent of ServerDesk/)
import { fileURLToPath } from 'node:url';

export const serverDeskRoot = fileURLToPath(new URL('../../', import.meta.url));
export const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
