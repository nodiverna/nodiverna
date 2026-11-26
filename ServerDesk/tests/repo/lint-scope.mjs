import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ESLint } from 'eslint';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';
import config, { lintExemptions } from '../../eslint.config.mjs';
import { serverDeskRoot } from '../support/paths.mjs';

// Lint covers whole source directories. New files are checked without editing
// package.json, and the only way around a rule is a justified per-file entry.
// The console lives in ui/ next to the routes in app/; lint names both, and the
// database rule (6b) covers both.
const root = serverDeskRoot;
const at = (relative) => path.join(root, relative);
let checks = 0;
const check = (condition, label) => { assert.ok(condition, label); checks++; };

const directories = ['app', 'ui', 'lib', 'db', 'runtime', 'scripts', 'tests', 'deploy', 'e2e'];
const mustFix = ['react-hooks/rules-of-hooks', '@typescript-eslint/no-explicit-any', '@typescript-eslint/no-unused-vars', 'prefer-const', '@next/next/no-assign-module-variable'];

// 1. Script form: directories plus files in the ServerDesk root, nothing deeper.
const script = JSON.parse(fs.readFileSync(at('package.json'), 'utf8')).scripts.lint;
const args = script.trim().split(/\s+/);
check(args[0] === 'eslint', 'lint script runs eslint directly');
const maxWarnings = args.indexOf('--max-warnings');
check(maxWarnings > 0 && args[maxWarnings + 1] === '0', 'lint script fails on any warning');
const targets = args.filter((arg, index) => index > 0 && !arg.startsWith('-') && index !== maxWarnings + 1);
check(targets.length === directories.length + 7, 'lint script names the nine directories and the seven root files');
for (const directory of directories) check(targets.includes(directory), `lint covers ${directory}/`);
check(!args.includes('--no-error-on-unmatched-pattern'), 'every lint target exists, so a missing one fails');
for (const target of targets) {
  if (directories.includes(target)) check(fs.statSync(at(target)).isDirectory(), `${target} is a directory`);
  else check(!/[\\/]/.test(target) && fs.statSync(at(target)).isFile(), `${target} is a file in the ServerDesk root, not a single file below a directory`);
}

const eslint = new ESLint({ cwd: root });

// 2. Build output, runtime data and generated sources stay out; real sources stay in.
for (const ignored of ['outputs/x.mjs', 'work/x.mjs', 'dist/x.js', '.data/x.mjs', '.vinext/x.mjs', '.build/x.mjs', 'coverage/x.js', 'agent/v3/bin/x.js', 'agent/v3/obj/x.js', 'e2e/artifacts/report/x.js', 'e2e/.auth/x.mjs', 'agent/package-v3.ts', 'drizzle/x.ts', '.next/x.js'])
  check(await eslint.isPathIgnored(at(ignored)), `${ignored} is ignored`);
for (const linted of ['ui/shell/console.tsx', 'lib/server/identity/passkeys.ts', 'app/api/agent/channel/route.ts', 'e2e/smoke.spec.ts', 'e2e/browser/forward.mjs'])
  check(!await eslint.isPathIgnored(at(linted)), `${linted} is linted`);

// 3. A new file under a lint target is checked without writing it to disk.
const probes = [
  { filePath: 'app/api/lint-probe/route.ts', code: 'export const probe: any = 1;\n', rule: '@typescript-eslint/no-explicit-any' },
  { filePath: 'app/lint-probe.tsx', code: "import { useState } from 'react';\nexport function Probe({ on }: { on: boolean }) {\n  if (on) {\n    const [value] = useState(0);\n    return <span>{value}</span>;\n  }\n  return null;\n}\n", rule: 'react-hooks/rules-of-hooks' },
];
for (const probe of probes) {
  check(!fs.existsSync(at(probe.filePath)), `${probe.filePath} does not exist on disk`);
  check(targets.includes(probe.filePath.split('/')[0]), `${probe.filePath} lies below a directory argument`);
  const [result] = await eslint.lintText(probe.code, { filePath: at(probe.filePath) });
  check(result.messages.some((message) => message.ruleId === probe.rule && message.severity === 2), `${probe.filePath} reports ${probe.rule} as an error`);
  check(!fs.existsSync(at(probe.filePath)), `${probe.filePath} was not written`);
}

// 3b. Owner checks go through lib/server/identity/policy/can.ts: on the server, role==='admin',
// importing globalOwnerGuard and hasGlobalPermission(…,'*') are errors, and so
// are their equivalents: x.permissions.includes('*'), x['role'],
// ['admin'].includes(role), switch(role){case 'admin'}, and globalOwnerGuard as
// a member, re-export or destructured name. Client components and lookalikes
// (grant_role, another right or role, a bare permissions variable) are not
// reported.
const ownerPreamble = [
  "import * as access from './access';",
  "import type {Viewer} from './types';",
  'declare const v: Viewer;',
];
// One spelling per exported statement, each reported exactly once on its line.
const ownerSpellings = [
  "export const a1 = v.permissions.includes('*');",
  "export const a2 = v.permissions?.includes('*');",
  "export const a3 = v?.permissions?.includes('*');",
  "export const b1 = v['role']==='admin';",
  "export const b2 = 'admin'!==v?.['role'];",
  "export const c1 = ['admin'].includes(v.role);",
  "export const c2 = ['admin','operator'].includes(role);",
  "export const c3 = ['viewer','admin'].includes(v?.role);",
  "export const c4 = ['admin'].includes(v['role']);",
  "export function d1(){switch(v.role){case 'admin':return 1;default:return 0;}}",
  "export function d2(){switch(v?.role){case 'viewer':return 0;case 'admin':return 1;}}",
  "export function d3(){switch(v['role']){case 'admin':return 1;}}",
  "export function d4(){switch(role){case 'admin':return 1;}}",
  "export const f1 = access.globalOwnerGuard('?');",
  "export const f2 = async()=>(await import('./access')).globalOwnerGuard;",
  "export {globalOwnerGuard} from './access';",
  "export {globalOwnerGuard as ownerGuard} from './access';",
  "export const h1 = async()=>{const {globalOwnerGuard}=await import('./access');return globalOwnerGuard;};",
  "export const h2 = ()=>{const {globalOwnerGuard: guard}=access;return guard;};",
];
const ownerLookalikes = [
  "export const a = permissions.includes('*');",
  "export const b = v.permissions.includes('view');",
  "export const c = ['operator'].includes(v.role);",
  "export const c2 = ['viewer','operator','admin'].includes(v.role);",
  "export function d(){switch(v.role){case 'viewer':return 1;}}",
  "export const f = access.hasGlobalPermission(v,'view');",
  "export const g = user['grant_role']==='admin';",
  'export const h = {globalOwnerGuard: 1};',
];
const lines = (...parts) => parts.flat().join('\n') + '\n';
const ownerProbes = [
  { filePath: 'lib/lint-probe.ts', reported: 4, code: "import {globalOwnerGuard} from './access';\nimport {hasGlobalPermission} from './access';\nimport type {Viewer} from './types';\ndeclare const v: Viewer;\nexport const a = v.role==='admin';\nexport const b = 'admin'!==v.role;\nexport const c = hasGlobalPermission(v,'*');\nexport const d = globalOwnerGuard;\n" },
  { filePath: 'app/api/lint-probe/route.ts', reported: 1, code: "import type {Viewer} from '@/lib/types';\ndeclare const v: Viewer;\nexport const a = v.role!=='admin';\n" },
  { filePath: 'app/downloads/lint-probe/route.ts', reported: 1, code: "import type {Viewer} from '@/lib/types';\ndeclare const v: Viewer;\nexport const a = v.role==='admin';\n" },
  { filePath: 'app/lint-probe.tsx', reported: 0, code: "import type {Viewer} from '@/lib/types';\ndeclare const viewer: Viewer;\nexport const a = viewer.role==='admin';\n" },
  { filePath: 'lib/lint-probe.ts', reported: 0, code: "import {hasGlobalPermission} from './access';\nimport type {Viewer} from './types';\ndeclare const v: Viewer;\ndeclare const user: {grant_role: string};\nexport const a = user.grant_role==='admin';\nexport const b = hasGlobalPermission(v,'portal.operator');\n" },
  { filePath: 'lib/lint-probe.ts', reported: ownerSpellings.length, perLine: true, code: lines(ownerPreamble, 'declare const role: string;', ownerSpellings) },
  { filePath: 'app/api/lint-probe/route.ts', reported: 1, code: lines("import type {Viewer} from '@/lib/types';", 'declare const v: Viewer;', "export const a = v.permissions?.includes('*');") },
  { filePath: 'app/lint-probe.tsx', reported: 0, code: lines("import type {Viewer} from '@/lib/types';", 'declare const viewer: Viewer;', "export const a = viewer.permissions?.includes('*');", "export const b = ['admin'].includes(viewer.role);") },
  { filePath: 'lib/lint-probe.ts', reported: 0, code: lines(ownerPreamble, 'declare const permissions: string[];', 'declare const user: {grant_role: string};', ownerLookalikes) },
];
for (const probe of ownerProbes) {
  check(!fs.existsSync(at(probe.filePath)), `${probe.filePath} does not exist on disk`);
  const [result] = await eslint.lintText(probe.code, { filePath: at(probe.filePath) });
  const owner = result.messages.filter((message) => message.ruleId === 'no-restricted-syntax');
  check(owner.length === probe.reported && owner.every((message) => message.severity === 2 && message.message.includes('lib/server/identity/policy/can.ts')), `${probe.filePath} reports ${probe.reported} Owner spelling(s) as errors pointing to lib/server/identity/policy/can.ts`);
  if (probe.perLine) {
    const statements = probe.code.split('\n').flatMap((line, index) => (line.startsWith('export ') ? [index + 1] : []));
    check(owner.map((message) => message.line).sort((a, b) => a - b).join() === statements.join(), `${probe.filePath} reports each Owner spelling once on its own line`);
  }
  check(!fs.existsSync(at(probe.filePath)), `${probe.filePath} was not written`);
}
// lib/server/identity/rbac.ts has no file exemption: the full Owner rule applies there.
{
  const [result] = await eslint.lintText(lines("import type {Viewer} from './types';", 'declare const v: Viewer;', "export const a = v.role==='admin';"), { filePath: at('lib/server/identity/rbac.ts') });
  const owner = result.messages.filter((message) => message.ruleId === 'no-restricted-syntax');
  check(owner.length === 1 && owner[0].severity === 2 && owner[0].message.includes('lib/server/identity/policy/can.ts'), 'lib/server/identity/rbac.ts reports an Owner spelling as an error');
}

// 4. The exemption list is well formed: one existing file, named rules, a reason.
check(Array.isArray(lintExemptions) && lintExemptions.length > 0, 'lintExemptions is an exported list');
check(!lintExemptions.some(({ file }) => file === 'lib/server/identity/rbac.ts'), 'lib/server/identity/rbac.ts has no file exemption');
const seenFiles = new Set();
for (const { file, rules, reason, ...rest } of lintExemptions) {
  check(Object.keys(rest).length === 0, `${file} has only file, rules and reason`);
  check(typeof file === 'string' && !/[*?{}[\]!]/.test(file) && !path.isAbsolute(file) && !file.split('/').includes('..'), `${file} is a plain relative path`);
  check(fs.statSync(at(file), { throwIfNoEntry: false })?.isFile() === true, `${file} exists`);
  check(!seenFiles.has(file), `${file} appears once`);
  seenFiles.add(file);
  check(Array.isArray(rules) && rules.length > 0 && new Set(rules).size === rules.length, `${file} names distinct rules`);
  for (const rule of rules) check(!mustFix.includes(rule), `${file} does not exempt ${rule}, which must be fixed`);
  check(typeof reason === 'string' && reason.trim().length >= 20 && /[.!?]$/.test(reason.trim()), `${file} gives a reason sentence`);
}

// Each entry becomes one block for exactly that file. Next's own presets aside,
// no block turns a rule off for a whole directory.
const off = (value) => (Array.isArray(value) ? value[0] : value) === 'off' || (Array.isArray(value) ? value[0] : value) === 0;
const ownBlocks = config.filter((block) => ![...nextVitals, ...nextTs].includes(block));
for (const { file, rules } of lintExemptions) {
  const block = ownBlocks.find((item) => item.files?.length === 1 && item.files[0] === file);
  check(block && Object.keys(block.rules).sort().join() === [...rules].sort().join() && Object.values(block.rules).every(off), `${file} has its own block that turns off exactly its rules`);
}
for (const block of ownBlocks) {
  if (!Object.values(block.rules ?? {}).some(off)) continue;
  check(block.files?.length === 1 && seenFiles.has(block.files[0]), `rules are only turned off for a single exempted file (${block.files})`);
}

// 5. Every exemption is still needed: re-enabling it for that file reports it.
const strict = new ESLint({ cwd: root, overrideConfig: lintExemptions.map(({ file, rules }) => ({ files: [file], rules: Object.fromEntries(rules.map((rule) => [rule, 'error'])) })) });
const results = await strict.lintFiles(lintExemptions.map(({ file }) => file));
for (const { file, rules } of lintExemptions) {
  const result = results.find((item) => item.filePath === at(file));
  for (const rule of rules) check(result?.messages.some((message) => message.ruleId === rule), `${file} still violates ${rule}`);
}

// 6. No rule is switched off globally.
const guarded = [...new Set([...lintExemptions.flatMap(({ rules }) => rules), ...mustFix, '@typescript-eslint/no-this-alias'])];
// no-restricted-syntax holds the Owner selectors, which apply to server files only (3b).
const serverOnly = ['no-restricted-syntax'];
for (const probe of ['app/lint-probe.tsx', 'lib/lint-probe.ts', 'tests/api/lint-probe.mjs']) {
  const calculated = await eslint.calculateConfigForFile(at(probe));
  for (const rule of guarded) if (probe.startsWith('lib/') || !serverOnly.includes(rule)) check(calculated.rules[rule] !== undefined && !off(calculated.rules[rule]), `${rule} is active for ${probe}`);
}
// Tests live in folders below tests/: a test in a subfolder gets the same rules as one at the top of tests/.
check(!fs.existsSync(at('tests/api/lint-probe.mjs')) && !fs.existsSync(at('tests/lint-probe.mjs')), 'the test probes do not exist on disk');
assert.deepEqual((await eslint.calculateConfigForFile(at('tests/api/lint-probe.mjs'))).rules, (await eslint.calculateConfigForFile(at('tests/lint-probe.mjs'))).rules, 'tests/api/lint-probe.mjs gets the rules of tests/lint-probe.mjs');
checks++;

// 6b. No database access in app/ and ui/: the data-layer imports, db(), the sql
// tag and SQL statement literals are errors with one message in every app and ui
// file; UI text that only starts like SQL is not. In app/api/** the owner-policy
// rule still fires next to it, because both selector lists are merged.
const databaseMessage = 'Database access belongs in a domain module under lib/server/.';
const appProbes = [
  ['app/api/lint-db/route.ts', "import {db} from '@/lib/server/db';\nexport const probe = db;\n", 'an import of @/lib/server/db'],
  ['app/lint-db.tsx', "import {sql} from '../runtime/database.mjs';\nexport const probe = sql;\n", 'an import of runtime/database.mjs'],
  ['app/api/lint-db/route.ts', 'declare function db(): unknown;\nexport const probe = db();\n', 'a db() call'],
  ['app/lint-db.tsx', 'declare const sql: (parts: TemplateStringsArray) => unknown;\nexport const probe = sql`SELECT 1`;\n', 'an sql tag'],
  ['app/api/lint-db/route.ts', "export const probe = 'INSERT INTO servers(id) VALUES($1)';\n", 'an INSERT INTO literal'],
  ['app/lint-db.tsx', 'export const probe = `DELETE FROM audit WHERE id=${1}`;\n', 'a DELETE FROM template'],
  ['ui/kit/lint-db.tsx', "import {db} from '@/lib/server/db';\nexport const probe = db;\n", 'an import of @/lib/server/db'],
  ['ui/kit/lint-db.tsx', 'declare function db(): unknown;\nexport const probe = db();\n', 'a db() call'],
];
for (const [filePath, code, label] of appProbes) {
  check(!fs.existsSync(at(filePath)), `${filePath} does not exist on disk`);
  const [result] = await eslint.lintText(code, { filePath: at(filePath) });
  check(result.messages.some((message) => message.severity === 2 && message.message.endsWith(databaseMessage)), `${filePath}: ${label} reports the database message`);
}
for (const [filePath, code] of [['app/lint-db.tsx', "export const label = 'Select a device';\nexport const other = 'Update available';\n"], ['app/api/lint-db/route.ts', "export const label = 'Delete from the list';\n"]]) {
  const [result] = await eslint.lintText(code, { filePath: at(filePath) });
  check(!result.messages.some((message) => message.message.endsWith(databaseMessage)), `${filePath}: UI text stays legal`);
}
{
  const [result] = await eslint.lintText("declare const v: {role: string};\nexport const owner = v.role === 'admin';\nexport const q = 'SELECT id FROM servers';\n", { filePath: at('app/api/lint-db/route.ts') });
  const texts = result.messages.map((message) => message.message);
  check(texts.includes(databaseMessage) && texts.some((text) => text.startsWith('Owner checks go through lib/server/identity/policy/can.ts')), 'app/api/**: the owner-policy and the database selectors both fire');
}
check(!lintExemptions.some(({ file, rules }) => /^(?:app|ui)\//.test(file) && rules.some((rule) => ['no-restricted-imports', 'no-restricted-syntax'].includes(rule))), 'no lint exemption turns the database rule off in app/ or ui/');

// 6c. Server-only code lives in lib/server/: a value import of it is an error of its own
// rule outside route handlers, runtime/, scripts/, tests/, lib/server/,
// instrumentation.ts and proxy.ts. An import type is legal. The rule matches the alias
// and the relative texts from lib/, and in ui/ it reports next to the database rule.
const boundaryRule = '@typescript-eslint/no-restricted-imports';
const boundaryMessage = 'Server-only code lives in lib/server/. Import it only from route handlers, runtime/, scripts/ and lib/server/; the client may import its types with import type.';
const valueImport = (specifier) => `import {now} from '${specifier}';\nexport const probe = now;\n`;
const typeImport = (specifier) => `import type {now} from '${specifier}';\nexport type Probe = typeof now;\n`;
const boundaryProbes = [
  ['ui/kit/lint-server.tsx', valueImport('@/lib/server/context'), true, 'a value import of @/lib/server/context in ui/'],
  ['ui/kit/lint-server.tsx', typeImport('@/lib/server/context'), false, 'an import type of @/lib/server/context in ui/'],
  ['app/lint-server/page.tsx', valueImport('@/lib/server/context'), true, 'a value import of @/lib/server/context in a page'],
  ['app/lint-server/page.tsx', typeImport('@/lib/server/context'), false, 'an import type of @/lib/server/context in a page'],
  ['lib/lint-server.ts', valueImport('./server/context'), true, './server/context directly in lib/'],
  ['lib/i18n/lint-server.ts', valueImport('../server/context'), true, '../server/context in lib/i18n/'],
  ['lib/server/devices/lint-server.ts', valueImport('../server/context'), false, '../server/context in lib/server/devices/'],
  ['app/api/lint-server/route.ts', valueImport('@/lib/server/context'), false, '@/lib/server/context in a route'],
];
for (const [filePath, code, reported, label] of boundaryProbes) {
  check(!fs.existsSync(at(filePath)), `${filePath} does not exist on disk`);
  const [result] = await eslint.lintText(code, { filePath: at(filePath) });
  const boundary = result.messages.filter((message) => message.ruleId === boundaryRule);
  check(reported ? boundary.length === 1 && boundary[0].severity === 2 && boundary[0].message.endsWith(boundaryMessage) : boundary.length === 0, `${label} ${reported ? 'is' : 'is not'} a server boundary error`);
}
{
  const [result] = await eslint.lintText(valueImport('@/lib/server/db'), { filePath: at('app/api/lint-server/route.ts') });
  check(result.messages.some((message) => message.ruleId === 'no-restricted-imports' && message.severity === 2 && message.message.endsWith(databaseMessage)) && !result.messages.some((message) => message.ruleId === boundaryRule), 'a route: @/lib/server/db is the database error, not a boundary error');
}
{
  const [result] = await eslint.lintText(valueImport('@/lib/server/db'), { filePath: at('ui/kit/lint-server.tsx') });
  check(result.messages.some((message) => message.ruleId === 'no-restricted-imports' && message.severity === 2 && message.message.endsWith(databaseMessage)), 'ui/: @/lib/server/db reports the database rule');
  check(result.messages.some((message) => message.ruleId === boundaryRule && message.severity === 2 && message.message.endsWith(boundaryMessage)), 'ui/: @/lib/server/db also reports the server boundary rule');
}
check(!lintExemptions.some(({ rules }) => rules.includes(boundaryRule)), 'no lint exemption turns the server boundary rule off');

// 7. Inline directives cover single lines, name their rules and say why.
const needle = 'eslint-' + 'disable';
const directive = new RegExp(`^${needle}-(?:next-)?line [\\w@/-]+(?:, ?[\\w@/-]+)* -- \\S`);
const sources = [];
const walk = (relative) => {
  for (const entry of fs.readdirSync(at(relative), { withFileTypes: true })) {
    const child = `${relative}/${entry.name}`;
    if (entry.isDirectory()) { if (!['e2e/.auth', 'e2e/artifacts'].includes(child)) walk(child); }
    else if (/\.(?:ts|tsx|mjs|js)$/.test(entry.name)) sources.push(child);
  }
};
for (const target of targets) { if (directories.includes(target)) walk(target); else sources.push(target); }
check(sources.length > 100, 'directive scan reads the source tree');
let directives = 0;
for (const file of sources) {
  const lines = fs.readFileSync(at(file), 'utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    for (let column = line.indexOf(needle); column !== -1; column = line.indexOf(needle, column + 1)) {
      directives++;
      check(directive.test(line.slice(column)), `${file}:${index + 1} uses a single-line directive with rule and reason`);
    }
  });
}
check(directives > 0, 'directive scan found the existing directives');

console.log(`${checks} lint scope checks passed.`);
