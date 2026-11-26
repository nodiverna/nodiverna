// Shared TypeScript loader for regression tests (Node.js 22.15 or newer).
//
// Use it in one of two ways:
//   1. As the first static import of a test, then load the code under test
//      dynamically, so the hooks are active before it is resolved:
//        import {mock} from '../support/register.mjs';
//        mock('lib/server/context.ts', {db: () => facade});
//        const {deleteRunbook} = await import('../../lib/server/automation/runbooks.ts');
//   2. As a preload: node --import ./tests/support/register.mjs tests/lib/x.mjs
//
// What the hooks do (module.registerHooks, synchronous and in-thread, so they
// cover import and require alike):
//   - .ts, .tsx and .mts files below ServerDesk/ (not node_modules) are
//     transpiled with typescript to ES modules (ESNext, ES2022, react-jsx).
//   - "@/..." resolves through compilerOptions.paths in tsconfig.json,
//     read at runtime. Relative imports and alias targets without a known
//     extension try: exact, .ts, .tsx, .mts, .js, .mjs, /index.ts, /index.tsx.
//   - .css imports are empty modules, "cloudflare:workers" is runtime/env.mjs
//     (as in next.config.ts), and a .json import without `with {type:'json'}`
//     gets the parsed file as its default export (as in the bundler).
//
// mock(target, exports) replaces one file or package for the whole process.
// Call it before the first import of the target; every spelling that resolves
// to the file ('./context', '../context', '@/lib/server/context') gets the mock.
//   - target is a path relative to ServerDesk/ with extension and forward
//     slashes ('lib/server/context.ts'), or a bare package specifier ('next/navigation').
//   - Each own enumerable key of `exports` is a named export. The default export
//     is exports.default if present, otherwise the object itself. Names the real
//     file exports at top level but the mock lacks are exported as undefined.
//
// Static imports of the test file itself are loaded before this module runs,
// so they bypass the hooks and the "already imported" check of mock().
import module from 'node:module';
import {existsSync, readFileSync, statSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const STATE = Symbol.for('serverdesk.tests.register');
const MOCK_SCHEME = 'serverdesk-mock:';
const PROBES = ['', '.ts', '.tsx', '.mts', '.js', '.mjs', '/index.ts', '/index.tsx'];
const TS_FILE = /\.(?:ts|tsx|mts)$/;
const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?|json|css)$/;

const rootDir = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const requireFromHere = module.createRequire(import.meta.url);
const urlKey = process.platform === 'win32' ? url => url.toLowerCase() : url => url;

/** compilerOptions.paths from tsconfig.json, read now, with the directory the targets are relative to. */
export function tsconfigPaths() {
  const file = path.join(rootDir, 'tsconfig.json');
  const text = readFileSync(file, 'utf8');
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    // tsconfig.json may contain comments; only then is typescript needed here.
    const parsed = typescript().parseConfigFileTextToJson(file, text);
    if (parsed.error) throw new Error(`tests/support/register.mjs cannot read tsconfig.json: ${parsed.error.messageText}`);
    config = parsed.config;
  }
  const options = config.compilerOptions ?? {};
  return {baseDir: path.resolve(rootDir, options.baseUrl ?? '.'), paths: options.paths ?? {}};
}

function createState() {
  const {baseDir, paths} = tsconfigPaths();
  return {
    registrations: 0,
    aliases: Object.entries(paths).map(([pattern, targets]) => {
      const star = pattern.indexOf('*');
      return {pattern, targets, prefix: star < 0 ? pattern : pattern.slice(0, star), suffix: star < 0 ? '' : pattern.slice(star + 1), exact: star < 0};
    }),
    baseDir,
    mocks: new Map(), // key -> {exports, file}
    urlMocks: new Map(), // urlKey(file URL) -> key
    specifierMocks: new Map(), // bare specifier -> key
    loaded: new Set(), // urlKey of every file URL and mock URL loaded through the hooks
    bareSpecifiers: new Set(),
    ts: null,
    resolving: false,
    probing: false,
  };
}

const state = globalThis[STATE] ??= createState();

function typescript() {
  const current = globalThis[STATE];
  if (current?.ts) return current.ts;
  const ts = requireFromHere('typescript');
  if (current) current.ts = ts;
  return ts;
}

/** What the running loader uses: alias patterns in tsconfig order and how often hooks were registered. */
export function loaderInfo() {
  return {aliasPatterns: state.aliases.map(alias => alias.pattern), registrations: state.registrations, root: rootDir};
}

function inside(directory, file) {
  const relative = path.relative(directory, file);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function projectFile(file) {
  return inside(rootDir, file) && !path.relative(rootDir, file).split(path.sep).includes('node_modules');
}

function isFile(file) {
  return statSync(file, {throwIfNoEntry: false})?.isFile() ?? false;
}

function probe(base) {
  for (const extension of PROBES) {
    const candidate = base + extension;
    if (isFile(candidate)) return candidate;
  }
  return null;
}

function notFound(specifier, parentURL) {
  const error = new Error(`Cannot find module '${specifier}' imported from ${parentURL ?? rootDir}`);
  error.code = 'ERR_MODULE_NOT_FOUND';
  return error;
}

// TypeScript's paths matching: an exact pattern wins, otherwise the matching
// pattern with the longest prefix; its targets are tried in order.
function matchAlias(specifier) {
  let best = null;
  for (const alias of state.aliases) {
    if (alias.exact) {
      if (specifier === alias.pattern) return {alias, star: ''};
      continue;
    }
    if (specifier.length >= alias.prefix.length + alias.suffix.length && specifier.startsWith(alias.prefix) && specifier.endsWith(alias.suffix)
      && (!best || alias.prefix.length > best.alias.prefix.length)) {
      best = {alias, star: specifier.slice(alias.prefix.length, specifier.length - alias.suffix.length)};
    }
  }
  return best;
}

function resolveAlias(specifier, match) {
  for (const target of match.alias.targets) {
    const found = probe(path.resolve(state.baseDir, target.replace('*', match.star)));
    if (found) return found;
  }
  return null;
}

const isRelative = specifier => specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../');
const isBare = specifier => !isRelative(specifier) && !specifier.startsWith('/') && !/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(specifier);

function mockUrl(key) {
  return MOCK_SCHEME + encodeURIComponent(key);
}

// A file URL that has a mock resolves to the mock, whatever query it carries.
function finish(url) {
  if (url.startsWith('file:')) {
    const mocked = state.urlMocks.get(urlKey(url.replace(/[?#][\s\S]*$/, '')));
    if (mocked) return {url: mockUrl(mocked), format: 'module', shortCircuit: true};
  }
  return {url, shortCircuit: true};
}

function resolve(specifier, context, nextResolve) {
  const {parentURL} = context;
  const parentFile = parentURL?.startsWith('file:') ? fileURLToPath(parentURL) : null;
  const fromProject = parentURL === undefined || (parentFile !== null && projectFile(parentFile));
  if (state.specifierMocks.has(specifier)) return {url: mockUrl(state.specifierMocks.get(specifier)), format: 'module', shortCircuit: true};
  if (specifier === 'cloudflare:workers') return finish(pathToFileURL(path.join(rootDir, 'runtime', 'env.mjs')).href);
  if (fromProject && parentFile && isRelative(specifier)) {
    const [, request, suffix] = /^([^?#]*)([\s\S]*)$/.exec(specifier);
    const found = probe(path.resolve(path.dirname(parentFile), request));
    if (!found) throw notFound(specifier, parentURL);
    return finish(pathToFileURL(found).href + suffix);
  }
  if (fromProject && isBare(specifier)) {
    const match = matchAlias(specifier);
    if (match) {
      const found = resolveAlias(specifier, match);
      if (!found) throw notFound(specifier, parentURL);
      return finish(pathToFileURL(found).href);
    }
  }
  if (isBare(specifier) && !state.probing) state.bareSpecifiers.add(specifier);
  let result;
  try {
    result = nextResolve(specifier, context);
  } catch (error) {
    // The bundler resolves package subpaths like CommonJS ('next/navigation'
    // finds next/navigation.js); native ESM does not, so fall back to require.
    if (!(fromProject && parentFile && isBare(specifier) && error?.code === 'ERR_MODULE_NOT_FOUND') || state.resolving) throw error;
    state.resolving = true;
    try {
      result = {url: pathToFileURL(module.createRequire(parentURL).resolve(specifier)).href};
    } catch {
      throw error;
    } finally {
      state.resolving = false;
    }
  }
  const mocked = finish(result.url);
  return mocked.url === result.url ? result : mocked;
}

function load(url, context, nextLoad) {
  if (url.startsWith(MOCK_SCHEME)) {
    const key = decodeURIComponent(url.slice(MOCK_SCHEME.length));
    state.loaded.add(urlKey(url));
    return {format: 'module', source: mockSource(key), shortCircuit: true};
  }
  if (url.startsWith('file:')) {
    const file = fileURLToPath(url);
    state.loaded.add(urlKey(pathToFileURL(file).href));
    if (file.endsWith('.css')) return {format: 'module', source: '', shortCircuit: true};
    if (projectFile(file) && TS_FILE.test(file) && !file.endsWith('.d.ts')) {
      return {format: 'module', source: transpile(file), shortCircuit: true};
    }
    if (projectFile(file) && file.endsWith('.json') && context.importAttributes?.type !== 'json' && !context.conditions?.includes('require')) {
      return {format: 'module', source: `export default ${withoutBom(readFileSync(file, 'utf8'))};`, shortCircuit: true};
    }
  }
  return nextLoad(url, context);
}

const withoutBom = text => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

function transpile(file) {
  const ts = typescript();
  return ts.transpileModule(readFileSync(file, 'utf8'), {
    fileName: file,
    compilerOptions: {module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true},
  }).outputText;
}

// Top-level runtime export names of a source file, following `export * from`
// into project files. Types, interfaces and `declare` statements have no value.
function exportNames(file, seen = new Set()) {
  if (seen.has(file)) return new Set();
  seen.add(file);
  const ts = typescript();
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, false);
  const names = new Set();
  const hasModifier = (node, kind) => node.modifiers?.some(modifier => modifier.kind === kind) ?? false;
  const bindingNames = name => {
    if (ts.isIdentifier(name)) names.add(name.text);
    else for (const element of name.elements) if (!ts.isOmittedExpression(element)) bindingNames(element.name);
  };
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue;
      if (!statement.exportClause) {
        const specifier = statement.moduleSpecifier?.text;
        const target = specifier && isRelative(specifier) ? probe(path.resolve(path.dirname(file), specifier))
          : specifier && matchAlias(specifier) ? resolveAlias(specifier, matchAlias(specifier)) : null;
        if (target && projectFile(target)) for (const name of exportNames(target, seen)) if (name !== 'default') names.add(name);
      } else if (ts.isNamespaceExport(statement.exportClause)) names.add(statement.exportClause.name.text);
      else for (const element of statement.exportClause.elements) if (!element.isTypeOnly) names.add(element.name.text);
      continue;
    }
    if (ts.isExportAssignment(statement)) {
      if (!statement.isExportEquals) names.add('default');
      continue;
    }
    if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword) || hasModifier(statement, ts.SyntaxKind.DeclareKeyword)) continue;
    if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) names.add('default');
    else if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) bindingNames(declaration.name);
    else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)) && statement.name) names.add(statement.name.text);
  }
  return names;
}

function mockSource(key) {
  const entry = state.mocks.get(key);
  if (!entry) throw new Error(`mock(): no mock registered for ${key}`);
  const own = Object.keys(entry.exports);
  const names = new Set(own);
  if (entry.file) for (const name of exportNames(entry.file)) names.add(name);
  names.delete('default');
  const lines = [`const mocked = globalThis[Symbol.for('serverdesk.tests.register')].mocks.get(${JSON.stringify(key)}).exports;`];
  let index = 0;
  for (const name of names) {
    const local = `export${index++}`;
    lines.push(own.includes(name) ? `const ${local} = mocked[${JSON.stringify(name)}];` : `const ${local} = undefined;`);
    lines.push(`export {${local} as ${JSON.stringify(name)}};`);
  }
  lines.push(`export default Object.hasOwn(mocked, 'default') ? mocked.default : mocked;`);
  return lines.join('\n');
}

/** Replace a project file or a package for every importer in this process; call it before the first import. */
export function mock(target, exports) {
  if (typeof target !== 'string' || target === '') throw new TypeError('mock(): target must be a path like lib/server/context.ts or a package name');
  if (exports === null || (typeof exports !== 'object' && typeof exports !== 'function')) throw new TypeError(`mock(): exports for ${target} must be an object`);
  if (target.includes('\\') || path.isAbsolute(target) || isRelative(target)) {
    throw new TypeError(`mock(): ${target} must be relative to the ServerDesk folder with forward slashes, e.g. lib/server/context.ts`);
  }
  const already = () => new Error(`mock(): ${target} was already imported; call mock() before the first import`);
  const file = path.resolve(rootDir, target);
  if (isFile(file)) {
    const url = urlKey(pathToFileURL(file).href);
    if (state.loaded.has(url) || state.loaded.has(urlKey(mockUrl(target)))) throw already();
    state.mocks.set(target, {exports, file});
    state.urlMocks.set(url, target);
    return;
  }
  const importedByName = state.bareSpecifiers.has(target);
  let resolved = null;
  try {
    state.probing = true;
    resolved = import.meta.resolve(target);
  } catch {
    // An uninstalled package (e.g. 'server-only') can still be mocked by name.
  } finally {
    state.probing = false;
  }
  if (resolved === null && (SOURCE_EXTENSION.test(target) || existsSync(path.join(rootDir, target.split('/')[0])))) {
    throw new Error(`mock(): ${target} does not exist`);
  }
  if (importedByName || state.loaded.has(urlKey(mockUrl(target))) || (resolved && state.loaded.has(urlKey(resolved)))) throw already();
  state.mocks.set(target, {exports, file: null});
  state.specifierMocks.set(target, target);
  if (resolved?.startsWith('file:')) state.urlMocks.set(urlKey(resolved), target);
}

/** Register the hooks once per process; later calls and later evaluations of this module do nothing. */
export function register() {
  if (state.registrations > 0) return false;
  if (typeof module.registerHooks !== 'function') {
    throw new Error('tests/support/register.mjs needs Node.js 22.15 or newer (module.registerHooks).');
  }
  module.registerHooks({resolve, load});
  state.registrations++;
  return true;
}

register();
