// The real client capability helpers (ui/base/access-capabilities.ts: isOwner and the
// can* checks) as a plain object, for view tests that stub the imports of a
// component by hand. The module has only a type import, so it needs no stubs.
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';

const file = fileURLToPath(new URL('../../ui/base/access-capabilities.ts', import.meta.url));
const mod = {exports: {}};
const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS}}).outputText;
new Function('require', 'module', 'exports', code)(id => { throw new Error('Unexpected import ' + id); }, mod, mod.exports);

export const accessCapabilities = mod.exports;
