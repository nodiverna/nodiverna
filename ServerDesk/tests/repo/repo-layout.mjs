// The layout of ServerDesk/ (CONTRIBUTING.md, "Project layout"): app/ holds only the Next.js route
// files, layout.tsx, page.tsx and globals.css; the browser console lives in ui/, ordered by area; files
// under app/ and ui/ import project files with the alias; ui/base and ui/kit import no area; lib/
// (lib/server/ included) imports nothing from app/ or ui/; server-only code lives in
// lib/server/<domain>/, a model that only the UI uses lives in ui/, and lib/ keeps what both sides
// run; only the server side value-imports lib/server/; tests/ mirrors the code in one folder per
// subject (ui/<area>/, lib/, api/, agent/, repo/, integration/) with its helpers in support/ and no
// root computed from a test's own place; every path that the sources and the documentation name
// exists, test paths included. Each rule also runs against a small in-memory tree that breaks it, so
// the test proves that the rule can fail.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {moduleSpecifiers} from '../support/module-specifiers.mjs';
import {serverDeskRoot} from '../support/paths.mjs';

const root = serverDeskRoot;
const repository = path.dirname(root);
let checks = 0;
const none = (violations, label) => { assert.deepEqual(violations, [], label); checks++; };
const fails = (violations, label) => { assert.ok(violations.length > 0, `the rule fails for a broken tree: ${label}`); checks++; };

// ---- The tree: files and folders below ServerDesk/ as posix paths, and a reader.
const skipped = new Set(['node_modules', '.next', '.git']);
// Build output and test artifacts below the walked folders.
const generated = new Set(['e2e/artifacts', 'e2e/.auth', 'agent/v3/bin', 'agent/v3/obj']);
const moduleFile = /\.(?:ts|tsx|mts|mjs|js|cjs)$/;
// The console and the routes, lib/, and the other server and client sources that import lib/
// (for the closures and the lib/server/ boundary).
const treeFolders = ['app', 'ui', 'lib', 'components', 'hooks', 'examples', 'runtime', 'scripts', 'db', 'e2e', 'deploy'];
function diskTree() {
  const files = [], dirs = [];
  const walk = relative => {
    for (const entry of fs.readdirSync(path.join(root, relative), {withFileTypes: true})) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) { if (!skipped.has(entry.name) && !generated.has(child)) { dirs.push(child); walk(child); } }
      else files.push(child);
    }
  };
  for (const top of treeFolders) if (fs.existsSync(path.join(root, top))) { dirs.push(top); walk(top); }
  for (const entry of fs.readdirSync(root, {withFileTypes: true})) if (entry.isFile() && moduleFile.test(entry.name)) files.push(entry.name);
  return {files, dirs, read: file => fs.readFileSync(path.join(root, file), 'utf8')};
}
/** An in-memory tree from {path: text}; folders follow from the paths. */
function memoryTree(entries) {
  const files = Object.keys(entries), dirs = new Set();
  for (const file of files) { const parts = file.split('/'); for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/')); }
  return {files, dirs: [...dirs], read: file => entries[file]};
}

const below = (tree, folder) => tree.files.filter(file => file.startsWith(folder + '/'));
const childrenOf = (tree, folder) => ({
  files: tree.files.filter(file => path.posix.dirname(file) === folder).map(file => path.posix.basename(file)).sort(),
  dirs: tree.dirs.filter(dir => path.posix.dirname(dir) === folder).map(dir => path.posix.basename(dir)).sort(),
});

// ---- AC rules. Each returns a list of violations.
const appRootFiles = ['globals.css', 'layout.tsx', 'page.tsx'];
/** app/ holds layout.tsx, page.tsx and globals.css directly, and below that only route.ts and page.tsx files. */
function appRule(tree) {
  const violations = [];
  const direct = childrenOf(tree, 'app').files;
  if (direct.join() !== appRootFiles.join()) violations.push(`app/ holds directly ${direct.join(', ')}`);
  for (const file of below(tree, 'app')) if (path.posix.dirname(file) !== 'app' && !['route.ts', 'page.tsx'].includes(path.posix.basename(file))) violations.push(`${file} is no route.ts or page.tsx`);
  return violations;
}
/** The old folders hold no file. */
const emptyFolders = ['app/redesign', 'components', 'hooks', 'examples'];
const emptyRule = tree => emptyFolders.flatMap(folder => below(tree, folder).map(file => `${file} lies in ${folder}/`));

const uiAreas = ['account', 'automation', 'base', 'devices', 'kit', 'session', 'settings', 'shell', 'styles'];
const deviceTopics = ['add-device', 'assistant', 'configuration', 'dashboard', 'device', 'diagnostics', 'extensions', 'fleet', 'hardware', 'history', 'inventory', 'management', 'monitoring', 'protection', 'remote'];
/** ui/ has exactly the area folders, ui/devices/ exactly the topic folders, neither holds a file, and nothing is deeper. */
function uiFolderRule(tree) {
  const violations = [];
  const ui = childrenOf(tree, 'ui'), devices = childrenOf(tree, 'ui/devices');
  if (ui.dirs.join() !== uiAreas.join()) violations.push(`ui/ has the folders ${ui.dirs.join(', ')}`);
  if (ui.files.length) violations.push(`ui/ holds the files ${ui.files.join(', ')}`);
  if (devices.dirs.join() !== deviceTopics.join()) violations.push(`ui/devices/ has the folders ${devices.dirs.join(', ')}`);
  if (devices.files.length) violations.push(`ui/devices/ holds the files ${devices.files.join(', ')}`);
  for (const dir of tree.dirs.filter(dir => dir.startsWith('ui/'))) {
    const depth = dir.split('/').length, allowed = dir.startsWith('ui/devices/') ? 3 : 2;
    if (depth > allowed) violations.push(`${dir} is deeper than ui/<area>/ or ui/devices/<topic>/`);
  }
  return violations;
}

// A dynamic route segment ([file]) and the public URL /Agent-v3-release.json keep their names.
const routeNameExceptions = new Set(['[file]', '[id]', '[slot]', 'Agent-v3-release.json']);
const lowerHyphen = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)*$/;
/** Lower case with hyphens under app/ and ui/; no generation or brand prefix and one base name per extension in ui/. */
function nameRule(tree) {
  const violations = [];
  for (const entry of [...tree.files, ...tree.dirs].filter(item => /^(app|ui)\//.test(item))) {
    const name = path.posix.basename(entry);
    if (!lowerHyphen.test(name) && !(entry.startsWith('app/') && routeNameExceptions.has(name))) violations.push(`${entry} is not lower case with hyphens`);
    if (entry.startsWith('ui/') && (/^(v3|sd|sdx)-/.test(name) || name.includes('redesign'))) violations.push(`${entry} has a generation or brand name`);
  }
  const seen = new Map();
  for (const file of below(tree, 'ui')) {
    const name = path.posix.basename(file);
    if (seen.has(name)) violations.push(`${file} and ${seen.get(name)} share the name ${name}`);
    else seen.set(name, file);
  }
  return violations;
}

const consoleSheets = ['classic-console.css', 'classic-forms.css', 'classic-panels.css', 'console.css', 'motion.css'];
/** ui/styles/ holds exactly the five console sheets, and app/globals.css imports the motion sheet from there. */
function stylesRule(tree) {
  const violations = [];
  const styles = childrenOf(tree, 'ui/styles');
  if (styles.files.join() !== consoleSheets.join() || styles.dirs.length) violations.push(`ui/styles/ holds ${[...styles.files, ...styles.dirs].join(', ')}`);
  const globals = tree.files.includes('app/globals.css') ? tree.read('app/globals.css') : '';
  if (!/^@import "\.\.\/ui\/styles\/motion\.css";$/m.test(globals)) violations.push('app/globals.css does not import ../ui/styles/motion.css');
  return violations;
}

// ---- Imports.
const sourceFile = /\.(?:ts|tsx)$/;
const scans = new WeakMap();
/** The module references of a file: {specifier, typeOnly}. An import whose named bindings are all `type` counts as type-only. */
function importsOf(tree, file) {
  let cache = scans.get(tree);
  if (!cache) scans.set(tree, cache = new Map());
  if (!cache.has(file)) {
    const {specifiers} = moduleSpecifiers(tree.read(file), file);
    cache.set(file, specifiers.map(({specifier, typeOnly, node}) => {
      const clause = ts.isImportDeclaration(node.parent) ? node.parent.importClause : undefined;
      const elements = clause?.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : undefined;
      const inlineTypes = !!clause && !clause.name && !!elements?.length && elements.every(element => element.isTypeOnly);
      return {specifier, typeOnly: typeOnly || inlineTypes};
    }));
  }
  return cache.get(file);
}
const relative = specifier => specifier.startsWith('./') || specifier.startsWith('../');
/** Inside app/ and ui/, every project import uses the alias; the only relative import is ./globals.css in app/layout.tsx. */
function aliasRule(tree) {
  const violations = [];
  for (const file of tree.files.filter(item => /^(app|ui)\//.test(item) && sourceFile.test(item)))
    for (const {specifier} of importsOf(tree, file))
      if (relative(specifier) && !(file === 'app/layout.tsx' && specifier === './globals.css')) violations.push(`${file} imports ${specifier} without the alias`);
  return violations;
}
/** The folder of ServerDesk/ that an import names, or undefined for a package. */
function targetOf(file, specifier) {
  if (specifier.startsWith('@/')) return specifier.slice(2);
  if (relative(specifier)) return path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
  return undefined;
}
const layers = {'ui/base': ['ui/base/', 'lib/'], 'ui/kit': ['ui/kit/', 'ui/base/', 'lib/']};
/** Value imports: base and kit stay below the areas, ui/ never imports app/, routes never import ui/. */
function layerRule(tree) {
  const violations = [];
  for (const file of tree.files.filter(item => /^(app|ui)\//.test(item) && sourceFile.test(item))) {
    for (const {specifier, typeOnly} of importsOf(tree, file)) {
      const target = targetOf(file, specifier);
      if (target === undefined || typeOnly) continue;
      const layer = Object.keys(layers).find(folder => file.startsWith(folder + '/'));
      if (layer && !layers[layer].some(prefix => target.startsWith(prefix))) violations.push(`${file} (${layer}) imports ${specifier}`);
      if (file.startsWith('ui/') && target.startsWith('app/')) violations.push(`${file} imports ${specifier} from app/`);
      if (file.startsWith('app/') && path.posix.basename(file) === 'route.ts' && target.startsWith('ui/')) violations.push(`the route ${file} imports ${specifier} from ui/`);
    }
  }
  return violations;
}
/** lib/ (lib/server/ included) imports nothing from app/ or ui/, in no form: also not as a type. There is no exception list. */
function libRule(tree) {
  const violations = [];
  for (const file of below(tree, 'lib').filter(item => moduleFile.test(item)))
    for (const {specifier} of importsOf(tree, file)) {
      const target = targetOf(file, specifier);
      if (target !== undefined && /^(app|ui)\//.test(target)) violations.push(`${file} imports ${specifier} from ${target.split('/')[0]}/`);
    }
  return violations;
}
/** At least 150 source files under ui/, so a walk that misses ui/ cannot pass unnoticed. */
const sizeRule = tree => { const count = below(tree, 'ui').filter(file => sourceFile.test(file)).length; return count >= 150 ? [] : [`ui/ holds only ${count} .ts and .tsx files`]; };

// ---- lib/server/: the server-only code, by domain.
const serverDomains = ['agent', 'automation', 'devices', 'errors', 'extensions', 'identity', 'notifications'];
const serverSubfolders = ['devices/gpu-drivers', 'devices/jobs', 'identity/entra', 'identity/policy', 'notifications/notify'];
/** lib/server/ has exactly the domain folders, only the listed subfolders below them, nothing deeper, and no index module. */
function serverFolderRule(tree) {
  const violations = [];
  const domains = childrenOf(tree, 'lib/server').dirs;
  if (domains.join() !== serverDomains.join()) violations.push(`lib/server/ has the folders ${domains.join(', ')}`);
  for (const dir of tree.dirs.filter(item => item.startsWith('lib/server/'))) {
    const inner = dir.slice('lib/server/'.length);
    if (inner.includes('/') && !serverSubfolders.includes(inner)) violations.push(`${dir} is no listed lib/server/ subfolder`);
  }
  for (const index of ['lib/server/index.ts', 'lib/server/index.tsx']) if (tree.files.includes(index)) violations.push(`${index} makes @/lib/server a module`);
  return violations;
}
/** The old places of the server code are gone: lib/server.ts, lib/v3.ts, lib/policy/ and lib/notify/. */
const oldServerFiles = ['lib/server.ts', 'lib/v3.ts'], oldServerFolders = ['lib/policy', 'lib/notify'];
const absentRule = tree => [
  ...oldServerFiles.filter(file => tree.files.includes(file)).map(file => `${file} exists`),
  ...oldServerFolders.filter(folder => tree.dirs.includes(folder) || below(tree, folder).length).map(folder => `${folder}/ exists`),
];
/** At least 120 .ts files under lib/server/, so a walk that misses lib/server/ cannot pass unnoticed. */
const serverSizeRule = tree => { const count = below(tree, 'lib/server').filter(file => file.endsWith('.ts')).length; return count >= 120 ? [] : [`lib/server/ holds only ${count} .ts files`]; };

// The client closure: every file that ui/, app/page.tsx and app/remote-desktop/page.tsx reach
// through value imports. The server closure: every file that the route handlers, app/layout.tsx,
// runtime/, scripts/, db/, instrumentation.ts, proxy.ts and next.config.ts reach through any
// import, without entering ui/.
const probes = ['', '.ts', '.tsx', '.mts', '.js', '.mjs', '.json', '/index.ts', '/index.tsx'];
const clientRoot = file => (file.startsWith('ui/') && moduleFile.test(file)) || file === 'app/page.tsx' || file === 'app/remote-desktop/page.tsx';
const serverRoot = file => moduleFile.test(file) && ((file.startsWith('app/') && path.posix.basename(file) === 'route.ts') || file === 'app/layout.tsx' || /^(runtime|scripts|db)\//.test(file) || ['instrumentation.ts', 'proxy.ts', 'next.config.ts'].includes(file));
function closure(tree, isRoot, {values, enterUi}) {
  const known = new Set(tree.files), roots = tree.files.filter(isRoot), seen = new Set(roots), queue = [...roots];
  while (queue.length) {
    const file = queue.pop();
    if (!moduleFile.test(file)) continue;
    for (const {specifier, typeOnly} of importsOf(tree, file)) {
      if (values && typeOnly) continue;
      const base = targetOf(file, specifier);
      const target = base === undefined ? undefined : probes.map(probe => base + probe).find(candidate => known.has(candidate));
      if (target === undefined || seen.has(target) || (!enterUi && target.startsWith('ui/'))) continue;
      seen.add(target); queue.push(target);
    }
  }
  return seen;
}
/** Every .ts file of lib/ outside lib/server/ (lib/types.ts aside, the type contract of both sides) runs on both sides: the client reaches it through a value import, and so does the server. */
function placementRule(tree) {
  const client = closure(tree, clientRoot, {values: true, enterUi: true}), server = closure(tree, serverRoot, {values: false, enterUi: false});
  const violations = [];
  for (const file of below(tree, 'lib').filter(item => item.endsWith('.ts') && !item.startsWith('lib/server/') && item !== 'lib/types.ts')) {
    if (!client.has(file)) violations.push(`${file} is server-only: it belongs in lib/server/<domain>/`);
    else if (!server.has(file)) violations.push(`${file} is used only by the UI: it belongs in its ui/ area`);
  }
  return violations;
}
// The server side may value-import lib/server/; tests load it as well.
const serverImporter = file => file.startsWith('lib/server/') || (file.startsWith('app/') && path.posix.basename(file) === 'route.ts') || /^(runtime|scripts|tests)\//.test(file) || ['instrumentation.ts', 'proxy.ts'].includes(file);
/** No file outside the server side value-imports a file under lib/server/, whatever the import text; import type is legal. */
function boundaryRule(tree) {
  const violations = [];
  for (const file of tree.files.filter(item => moduleFile.test(item) && !serverImporter(item)))
    for (const {specifier, typeOnly} of importsOf(tree, file)) {
      const target = targetOf(file, specifier);
      if (!typeOnly && target !== undefined && target.startsWith('lib/server/')) violations.push(`${file} imports the server-only ${specifier}`);
    }
  return violations;
}

// ---- tests/ mirrors the code: one folder level per subject (ui/<area>/ two), helpers in support/, data in
// fixtures/, the files of pnpm test:selfhost and test:http in integration/ (CONTRIBUTING.md, "Project layout").
const testFolders = ['agent', 'api', 'fixtures', 'integration', 'lib', 'repo', 'support', 'ui'];
// Folders that hold only .mjs test files and no subfolder.
const flatTestFolders = ['agent', 'api', 'integration', 'lib', 'repo', ...uiAreas.map(area => `ui/${area}`)];
// A root computed from the test's own place (tests/support/paths.mjs gives serverDeskRoot and repositoryRoot).
const ownRoot = [
  /new URL\(\s*(['"`])\.\.(?:\/\.\.)?\/?\1\s*[,+]/,
  /new URL\(\s*(['"`])\.\.\/(?:\.\.\/)?\1\s*\+/,
  /new URL\(\s*`\.\.\/(?:\.\.\/)?\$\{/,
  /path\.(?:resolve|join)\(\s*(?:__dirname|import\.meta\.dirname)\s*,\s*(['"`])\.\./,
];
/** The tree below tests/ (paths start with tests/). */
function testsTree() {
  const files = [], dirs = [];
  const walk = relative => {
    for (const entry of fs.readdirSync(path.join(root, relative), {withFileTypes: true})) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) { dirs.push(child); walk(child); } else files.push(child);
    }
  };
  dirs.push('tests'); walk('tests');
  return {files, dirs, read: file => fs.readFileSync(path.join(root, file), 'utf8')};
}
/** tests/ holds exactly its folders, no .mjs at its root, flat subject folders, unique run names, no own roots and the suite. */
function testsRule(tree) {
  const violations = [];
  const top = childrenOf(tree, 'tests');
  for (const file of top.files.filter(file => file.endsWith('.mjs'))) violations.push(`tests/${file} lies at the root of tests/`);
  if (top.dirs.join() !== testFolders.join()) violations.push(`tests/ has the folders ${top.dirs.join(', ')}`);
  const ui = childrenOf(tree, 'tests/ui');
  if (ui.files.length) violations.push(`tests/ui/ holds the files ${ui.files.join(', ')}`);
  for (const area of ui.dirs.filter(area => !uiAreas.includes(area))) violations.push(`tests/ui/${area}/ is no ui/ area`);
  for (const folder of flatTestFolders) {
    const {files, dirs} = childrenOf(tree, `tests/${folder}`);
    for (const dir of dirs) violations.push(`tests/${folder}/${dir}/ is a folder below tests/${folder}/`);
    for (const file of files.filter(file => !file.endsWith('.mjs'))) violations.push(`tests/${folder}/${file} is no .mjs file`);
  }
  for (const dir of tree.dirs.filter(dir => /^tests\/ui\/[^/]+\//.test(dir) && !flatTestFolders.includes(dir.slice('tests/'.length).split('/').slice(0, 2).join('/')))) violations.push(`${dir} lies below an unknown tests/ui/ area`);
  const testFiles = tree.files.filter(file => file.endsWith('.mjs') && !/^tests\/(?:support|fixtures)\//.test(file));
  const seen = new Map();
  for (const file of testFiles) {
    const name = path.posix.basename(file);
    if (seen.has(name)) violations.push(`${file} and ${seen.get(name)} share the name ${name}`);
    else seen.set(name, file);
  }
  for (const file of testFiles) if (ownRoot.some(pattern => pattern.test(tree.read(file)))) violations.push(`${file} computes a root from its own place; import it from tests/support/paths.mjs`);
  const runFiles = testFiles.filter(file => !file.startsWith('tests/integration/'));
  if (runFiles.length < 350) violations.push(`tests/ holds only ${runFiles.length} run files`);
  return violations;
}

// ---- Path mentions: every app/…, ui/…, lib/… and tests/… file path in the sources and the documentation exists.
const mention = /(?<![\w.@/-])(?:ServerDesk\/)?((?:app|ui)\/[\w.[\]/-]*?\.(?:tsx|ts|css)|lib\/[\w.[\]/-]*?\.(?:tsx|ts|json)|tests\/(?:[\w-]+\/)*[\w-]+\.mjs)(?![\w-])/g;
const binary = /\.(?:png|jpe?g|gif|ico|webp|woff2?|wasm|zip|exe|dll|pem|tsbuildinfo)$/i;
/** The mentions in `texts` ({name: text}) whose path does not satisfy `exists`. */
function mentionRule(texts, exists) {
  const violations = [];
  for (const [name, text] of Object.entries(texts)) for (const match of text.matchAll(mention)) if (!exists(match[1])) violations.push(`${name} names ${match[1]}, which does not exist`);
  return violations;
}
function mentionTexts() {
  const texts = {};
  const add = file => { if (!binary.test(file)) { const text = fs.readFileSync(file, 'utf8'); if (!text.includes('\0')) texts[path.relative(repository, file).split(path.sep).join('/')] = text; } };
  // agent/ without its build output (agent/v3/bin/, agent/v3/obj/); drizzle/ holds released migrations and stays unscanned.
  const agentOutput = new Set(['agent/v3/bin', 'agent/v3/obj']);
  const walk = dir => { for (const entry of fs.readdirSync(dir, {withFileTypes: true})) { const full = path.join(dir, entry.name); if (entry.isDirectory()) { if (!skipped.has(entry.name) && !agentOutput.has(path.relative(root, full).split(path.sep).join('/'))) walk(full); } else add(full); } };
  for (const folder of ['app', 'ui', 'lib', 'db', 'runtime', 'scripts', 'e2e', 'docs', 'deploy', 'agent']) if (fs.existsSync(path.join(root, folder))) walk(path.join(root, folder));
  for (const entry of fs.readdirSync(root, {withFileTypes: true})) if (entry.isFile()) add(path.join(root, entry.name));
  for (const name of ['README.md', 'CONTRIBUTING.md']) add(path.join(repository, name));
  return texts;
}

// ---- The real tree passes every rule.
const tree = diskTree();
none(appRule(tree), 'app/ holds only layout.tsx, page.tsx, globals.css and route files');
none(emptyRule(tree), 'the old console folders hold no file');
none(uiFolderRule(tree), 'ui/ and ui/devices/ hold exactly their folders and no file');
none(nameRule(tree), 'names under app/ and ui/ are lower case with hyphens, without old prefixes, unique in ui/');
none(stylesRule(tree), 'ui/styles/ holds the five console sheets');
none(aliasRule(tree), 'files under app/ and ui/ import project files with the alias');
none(layerRule(tree), 'ui/base and ui/kit import no area, ui/ no app/, routes no ui/');
none(libRule(tree), 'lib/ imports nothing from app/ or ui/, also not as a type');
none(sizeRule(tree), 'ui/ holds the console sources');
none(serverFolderRule(tree), 'lib/server/ holds exactly its domain folders and subfolders');
none(absentRule(tree), 'lib/server.ts, lib/v3.ts, lib/policy/ and lib/notify/ are gone');
none(serverSizeRule(tree), 'lib/server/ holds the server sources');
none(placementRule(tree), 'every lib/ file outside lib/server/ runs on both sides');
none(boundaryRule(tree), 'only the server side value-imports lib/server/');
const texts = mentionTexts();
assert.ok(Object.keys(texts).some(name => name.startsWith('ServerDesk/docs/')) && texts['CONTRIBUTING.md'] && texts['ServerDesk/ui/shell/console.tsx'] && texts['ServerDesk/agent/v3/README.md'], 'the mention scan reads docs/, ui/, agent/ and CONTRIBUTING.md');
assert.ok(!Object.keys(texts).some(name => /^ServerDesk\/(?:drizzle|agent\/v3\/(?:bin|obj))\//.test(name)), 'the mention scan skips drizzle/ and the agent build output');
none(mentionRule(texts, file => fs.existsSync(path.join(root, file))), 'every file path that the sources and the documentation name exists');
const testMentions = Object.values(texts).flatMap(text => [...text.matchAll(mention)].map(match => match[1]).filter(file => file.startsWith('tests/')));
assert.ok(testMentions.length > 50 && testMentions.includes('tests/repo/repo-layout.mjs'), `the mention scan sees test paths (${testMentions.length})`);
assert.ok(!Object.keys(texts).some(name => name.startsWith('ServerDesk/tests/')), 'the mention scan leaves the text of tests/ unscanned');
const testTree = testsTree();
none(testsRule(testTree), 'tests/ mirrors the code: its folders, flat subject folders, unique run names, roots from tests/support/paths.mjs');
assert.deepEqual(childrenOf(testTree, 'tests/ui').dirs, uiAreas, 'tests/ui/ holds a folder for each ui/ area');
checks++;

// ---- Each rule fails for a tree that breaks it.
const routes = {'app/layout.tsx': '', 'app/page.tsx': '', 'app/globals.css': '@import "../ui/styles/motion.css";\n', 'app/api/x/route.ts': ''};
const validUi = {
  ...Object.fromEntries(uiAreas.filter(area => area !== 'devices').map(area => [`ui/${area}/${area}-probe.ts`, ''])),
  ...Object.fromEntries(deviceTopics.map(topic => [`ui/devices/${topic}/${topic}-probe.ts`, ''])),
  ...Object.fromEntries(consoleSheets.map(sheet => [`ui/styles/${sheet}`, ''])),
};
delete validUi['ui/styles/styles-probe.ts'];
const valid = memoryTree({...routes, ...validUi});
for (const rule of [appRule, emptyRule, uiFolderRule, nameRule, stylesRule, aliasRule]) none(rule(valid), `the in-memory tree passes ${rule.name}`);
none(layerRule(valid), 'the in-memory tree passes layerRule');
fails(appRule(memoryTree({...routes, 'app/route-model.ts': ''})), 'a module directly in app/');
fails(appRule(memoryTree({...routes, 'app/remote-desktop/client-view.tsx': ''})), 'a view in a route folder');
fails(appRule(memoryTree({'app/page.tsx': '', 'app/globals.css': ''})), 'app/layout.tsx is missing');
for (const folder of emptyFolders) fails(emptyRule(memoryTree({...routes, [`${folder}/kit.tsx`]: ''})), `a file in ${folder}/`);
fails(uiFolderRule(memoryTree({...validUi, 'ui/widgets/x.ts': ''})), 'an unknown area');
fails(uiFolderRule(memoryTree({...validUi, 'ui/kit.tsx': ''})), 'a file directly in ui/');
fails(uiFolderRule(memoryTree({...validUi, 'ui/devices/device.tsx': ''})), 'a file directly in ui/devices/');
fails(uiFolderRule(memoryTree({...validUi, 'ui/devices/gadgets/x.tsx': ''})), 'an unknown device topic');
fails(uiFolderRule(memoryTree({...validUi, 'ui/kit/parts/x.tsx': ''})), 'a folder below an area');
fails(uiFolderRule(memoryTree({...validUi, 'ui/devices/fleet/parts/x.tsx': ''})), 'a folder below a device topic');
fails(nameRule(memoryTree({...validUi, 'ui/kit/DataTable.tsx': ''})), 'an upper-case name');
fails(nameRule(memoryTree({...validUi, 'ui/kit/data_table.tsx': ''})), 'an underscore');
fails(nameRule(memoryTree({...routes, 'app/api/Devices/route.ts': ''})), 'an upper-case route folder');
for (const name of ['v3-probe.tsx', 'sd-card.tsx', 'sdx-card.tsx', 'redesign-probe.css']) fails(nameRule(memoryTree({...validUi, [`ui/kit/${name}`]: ''})), `the name ${name}`);
fails(nameRule(memoryTree({...validUi, 'ui/kit/tags.tsx': '', 'ui/devices/configuration/tags.tsx': ''})), 'one base name twice');
fails(stylesRule(memoryTree({...routes, ...validUi, 'ui/styles/kit.css': ''})), 'a sixth sheet in ui/styles/');
fails(stylesRule(memoryTree({...routes, ...Object.fromEntries(Object.entries(validUi).filter(([file]) => file !== 'ui/styles/motion.css'))})), 'a console sheet is missing');
fails(stylesRule(memoryTree({...validUi, ...routes, 'app/globals.css': '@import "./animation.css";\n'})), 'globals.css imports another motion sheet');
fails(aliasRule(memoryTree({...validUi, 'ui/kit/kit.tsx': "import {Probe} from './probe';\n"})), 'a relative import in the same folder');
fails(aliasRule(memoryTree({...validUi, 'ui/kit/kit.tsx': "import './probe.css';\n"})), 'a relative stylesheet import');
fails(aliasRule(memoryTree({...validUi, 'ui/shell/shell.tsx': "import type {Viewer} from '../../lib/types';\n"})), 'a relative import of lib/');
fails(aliasRule(memoryTree({...routes, 'app/remote-desktop/page.tsx': "export default async function Page(){return import('../../ui/devices/remote/remote-desktop-paused');}\n"})), 'a relative import() in app/');
const layered = {...routes, ...validUi};
fails(layerRule(memoryTree({...layered, 'ui/base/http.ts': "import {Btn} from '@/ui/kit/kit';\n"})), 'ui/base imports ui/kit');
fails(layerRule(memoryTree({...layered, 'ui/kit/kit.tsx': "import {navIcons} from '@/ui/shell/nav-icons';\n"})), 'ui/kit imports an area');
none(layerRule(memoryTree({...layered, 'ui/kit/kit.tsx': "import type {Device} from '@/ui/devices/device/device';\nimport {type Route} from '@/ui/shell/nav-model';\n"})), 'type-only imports do not count');
fails(layerRule(memoryTree({...layered, 'ui/shell/shell.tsx': "import {x} from '@/app/api/x/route';\n"})), 'ui/ imports app/');
fails(layerRule(memoryTree({...layered, 'app/api/x/route.ts': "import {http} from '@/ui/base/http';\n"})), 'a route imports ui/');
none(libRule(memoryTree({...layered, 'lib/x.ts': "import type {Viewer} from './types';\nimport {db} from './server/db';\n"})), 'the in-memory tree passes libRule');
fails(libRule(memoryTree({...layered, 'lib/x.ts': "import {route} from '../app/route-model';\n"})), 'lib/ imports app/');
fails(libRule(memoryTree({...layered, 'lib/x.ts': "import {isOwner} from '@/ui/base/access-capabilities';\n"})), 'a lib/ file imports ui/base/access-capabilities');
fails(libRule(memoryTree({...layered, 'lib/x.ts': "import type {Device} from '@/ui/devices/device/device';\n"})), 'a lib/ file imports a type from ui/');
fails(libRule(memoryTree({...layered, 'lib/server/devices/x.ts': "import {Btn} from '../../../ui/kit/kit';\n"})), 'a lib/server/ file imports ui/ relatively');
fails(libRule(memoryTree({...layered, 'lib/x.ts': "export const load = () => import('@/app/api/x/route');\n"})), 'a lib/ file imports app/ dynamically');
fails(sizeRule(valid), 'ui/ holds fewer than 150 source files');
// lib/server/: domain folders, the old places, the size floor.
const validServer = {
  ...Object.fromEntries(serverDomains.map(domain => [`lib/server/${domain}/${domain}-probe.ts`, ''])),
  ...Object.fromEntries(serverSubfolders.map(folder => [`lib/server/${folder}/probe.ts`, ''])),
  'lib/server/context.ts': '', 'lib/types.ts': '',
};
for (const rule of [serverFolderRule, absentRule]) none(rule(memoryTree(validServer)), `the in-memory tree passes ${rule.name}`);
fails(serverFolderRule(memoryTree({...validServer, 'lib/server/misc/x.ts': ''})), 'a folder lib/server/misc/');
fails(serverFolderRule(memoryTree(Object.fromEntries(Object.entries(validServer).filter(([file]) => !file.startsWith('lib/server/errors/'))))), 'a domain folder is missing');
fails(serverFolderRule(memoryTree({...validServer, 'lib/server/devices/assistant/x.ts': ''})), 'an unlisted subfolder of a domain');
fails(serverFolderRule(memoryTree({...validServer, 'lib/server/identity/entra/graph/x.ts': ''})), 'a folder below a listed subfolder');
fails(serverFolderRule(memoryTree({...validServer, 'lib/server/index.ts': ''})), 'lib/server/index.ts');
for (const file of ['lib/server.ts', 'lib/v3.ts', 'lib/policy/can.ts', 'lib/notify/send.ts']) fails(absentRule(memoryTree({...validServer, [file]: ''})), `${file} exists`);
none(serverSizeRule(memoryTree(Object.fromEntries(Array.from({length: 120}, (_, i) => [`lib/server/devices/probe-${i}.ts`, ''])))), 'lib/server/ with 120 .ts files passes serverSizeRule');
fails(serverSizeRule(memoryTree(validServer)), 'lib/server/ holds fewer than 120 .ts files');
// Placement: a shared file is reached by a value import from the client and by the server.
const placed = {
  ...routes,
  'app/page.tsx': "import {Console} from '@/ui/shell/console';\nexport default Console;\n",
  'ui/shell/console.tsx': "import {shared} from '@/lib/shared';\nimport type {Viewer} from '@/lib/types';\nexport const Console = () => shared;\n",
  'app/api/x/route.ts': "import {shared} from '@/lib/shared';\nexport const GET = () => shared;\n",
  'lib/shared.ts': "import type {Viewer} from './types';\nexport const shared = 1;\n",
  'lib/types.ts': 'export type Viewer = {id: string};\n',
};
none(placementRule(memoryTree(placed)), 'the in-memory tree passes placementRule (lib/types.ts is reached only as a type)');
fails(placementRule(memoryTree({...placed, 'lib/server-probe.ts': 'export const x = 1;\n', 'app/api/x/route.ts': "import {shared} from '@/lib/shared';\nimport {x} from '@/lib/server-probe';\nexport const GET = () => shared + x;\n"})), 'a server-only file in lib/');
fails(placementRule(memoryTree({...placed, 'lib/ui-probe.ts': 'export const y = 1;\n', 'ui/shell/console.tsx': "import {shared} from '@/lib/shared';\nimport {y} from '@/lib/ui-probe';\nexport const Console = () => shared + y;\n"})), 'a UI-only file in lib/');
fails(placementRule(memoryTree({...placed, 'ui/shell/console.tsx': "import type {shared} from '@/lib/shared';\nexport const Console = () => 0;\n"})), 'a lib/ file that the client imports only as a type');
fails(placementRule(memoryTree({...placed, 'lib/ui-probe.ts': 'export const y = 1;\n', 'ui/shell/console.tsx': "import {shared} from '@/lib/shared';\nimport {y} from '@/lib/ui-probe';\nexport const Console = () => shared + y;\n", 'app/api/x/route.ts': "import {shared} from '@/lib/shared';\nimport {Console} from '@/ui/shell/console';\nexport const GET = () => shared + Console();\n"})), 'a lib/ file that the server reaches only through ui/');
// The boundary: the import target counts, not the text.
none(boundaryRule(memoryTree({...layered, 'ui/kit/kit.tsx': "import type {Queryable} from '@/lib/server/db';\n", 'app/api/x/route.ts': "import {db} from '@/lib/server/db';\n", 'lib/server/devices/x.ts': "import {db} from '../db';\n", 'runtime/x.mjs': "import {db} from '../lib/server/db.ts';\n", 'instrumentation.ts': "export const x = () => import('./lib/server/devices/alerts');\n"})), 'the in-memory tree passes boundaryRule');
fails(boundaryRule(memoryTree({...layered, 'ui/kit/kit.tsx': "import {db} from '@/lib/server/db';\n"})), 'a ui/ file with a value import of lib/server/db.ts');
fails(boundaryRule(memoryTree({...layered, 'app/devices/page.tsx': "import {now} from '@/lib/server/context';\n"})), 'a page with a value import of lib/server/');
fails(boundaryRule(memoryTree({...layered, 'lib/x.ts': "import {now} from './server/context';\n"})), 'a shared lib/ file with a value import of lib/server/');
fails(boundaryRule(memoryTree({...layered, 'lib/i18n/x.ts': "export const load = () => import('../server/context');\n"})), 'a dynamic import of lib/server/ from lib/i18n/');
fails(boundaryRule(memoryTree({...layered, 'e2e/x.spec.ts': "import {db} from '../lib/server/db';\n"})), 'an e2e file with a value import of lib/server/');
none(mentionRule({'a.md': 'See `ui/kit/kit.tsx`, ServerDesk/lib/types.ts and app/api/x/route.ts.'}, file => ['ui/kit/kit.tsx', 'lib/types.ts', 'app/api/x/route.ts'].includes(file)), 'existing mentions pass');
fails(mentionRule({'a.md': 'See ui/kit/missing.tsx.'}, () => false), 'a mention of a missing file');
fails(mentionRule({'a.ts': '// lib/missing.json holds it'}, () => false), 'a mention of a missing lib/ file');
const movedTests = file => file === 'tests/api/alerts.mjs';
fails(mentionRule({'a.md': 'Run `node tests/alerts.mjs`.'}, movedTests), 'a mention of tests/alerts.mjs, a test that moved to tests/api/');
fails(mentionRule({'a.md': 'See ServerDesk/tests/alerts.mjs.'}, movedTests), 'a mention of ServerDesk/tests/alerts.mjs');
none(mentionRule({'a.md': 'Run `node tests/api/alerts.mjs` (ServerDesk/tests/api/alerts.mjs).'}, movedTests), 'a mention of tests/api/alerts.mjs passes');
// tests/: each part of the rule fails for a tree that breaks it.
const testRuns = Object.fromEntries(Array.from({length: 350}, (_, i) => [`tests/${['api', 'lib', 'repo', 'agent'][i % 4]}/probe-${i}.mjs`, '']));
const validTests = {
  ...testRuns,
  ...Object.fromEntries(uiAreas.map(area => [`tests/ui/${area}/${area}-view.mjs`, ''])),
  // A helper in support/ may compute a root (built from parts, as below).
  'tests/integration/selfhost-probe.mjs': '', 'tests/support/paths.mjs': `export const serverDeskRoot = fileURLToPath(${['new', 'URL'].join(' ')}('../../', import.meta.url));\n`,
  'tests/support/fixtures/target.ts': '', 'tests/fixtures/data.json': '',
  'tests/lib/rooted.mjs': "import {serverDeskRoot} from '../support/paths.mjs';\nconst x = new URL('../../lib/types.ts', import.meta.url);\n",
};
none(testsRule(memoryTree(validTests)), 'the in-memory tree passes testsRule');
const brokenTests = {
  'a .mjs file at the root of tests/': {'tests/alerts.mjs': ''},
  'a folder tests/misc/': {'tests/misc/x.mjs': ''},
  'a folder below tests/ui/kit/': {'tests/ui/kit/sub/x.mjs': ''},
  'a file directly in tests/ui/': {'tests/ui/x.mjs': ''},
  'a tests/ui/ area that is no ui/ area': {'tests/ui/widgets/x.mjs': ''},
  'a folder below tests/lib/': {'tests/lib/server/x.mjs': ''},
  'a folder below tests/api/': {'tests/api/sub/x.mjs': ''},
  'a folder below tests/agent/': {'tests/agent/sub/x.mjs': ''},
  'a folder below tests/repo/': {'tests/repo/sub/x.mjs': ''},
  'a folder below tests/integration/': {'tests/integration/sub/x.mjs': ''},
  'a file that is no .mjs in tests/api/': {'tests/api/notes.txt': ''},
  'one base name in api/ and lib/': {'tests/api/alerts.mjs': '', 'tests/lib/alerts.mjs': ''},
  'one base name in lib/ and ui/devices/': {'tests/ui/devices/probe-1.mjs': ''},
  'one base name in repo/ and integration/': {'tests/integration/probe-2.mjs': ''},
  // The root computations are built from parts, so this file itself passes testsRule.
  ...Object.fromEntries([
    ["'..', import.meta.url", 'tests/lib/x.mjs'], ['"../", import.meta.url', 'tests/ui/kit/x.mjs'], ["'../..', import.meta.url", 'tests/repo/x.mjs'],
    ["`../../`, import.meta.url", 'tests/repo/x.mjs'], ["'../'+file, import.meta.url", 'tests/ui/devices/x.mjs'],
    ['`../${file}`, import.meta.url', 'tests/repo/x.mjs'],
  ].map(([args, file]) => [`new URL(${args}) in a test`, {[file]: `const root = fileURLToPath(${['new', 'URL'].join(' ')}(${args}));\n`}])),
  ...Object.fromEntries([['resolve', '__dirname', "'..'"], ['join', 'import.meta.dirname', "'../..'"]]
    .map(([call, base, up]) => [`path.${call}(${base}, ${up}) in a test`, {'tests/api/x.mjs': `const root = ${['path', call].join('.')}(${base}, ${up});\n`}])),
};
for (const [label, entries] of Object.entries(brokenTests)) fails(testsRule(memoryTree({...validTests, ...entries})), label);
fails(testsRule(memoryTree(Object.fromEntries(Object.entries(validTests).filter(([file]) => file !== 'tests/fixtures/data.json')))), 'a folder of tests/ is missing');
fails(testsRule(memoryTree(Object.fromEntries(Object.entries(validTests).filter(([file]) => !/\/probe-1?[0-9]\.mjs$/.test(file))))), 'fewer than 350 run files');

console.log(`${checks} repository layout checks passed.`);
