import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { compile } from '../../runtime/database.mjs';
import { maintenanceSelections } from '../../scripts/selfhost.mjs';
import { serverDeskRoot } from '../support/paths.mjs';

// transfers.state is free text, so a new transfer state is only visible as an
// SQL literal or as a bound value (an interpolation of the sql tag). runMaintenance clears a transfer only when
// its state is listed in maintenanceSelections.transfers; a state missing there
// would keep its chunks and storage objects forever. This test scans the code
// for every transfer state and requires maintenance to handle each one.

const root = serverDeskRoot;
const finalState = 'expired';
const sourceDirectories = ['app', 'ui', 'lib', 'db', 'runtime', 'scripts', 'deploy'];
const sourceExtensions = new Set(['.ts', '.tsx', '.mjs', '.js']);

// --- Known states -----------------------------------------------------------

function literals(list) {
  return [...list.matchAll(/'([^']*)'/g)].map((match) => match[1]);
}

/** The items of an IN list: quoted literals and bound values ($n of values). */
function listItems(list, values) {
  return [...list.matchAll(/'([^']*)'|\$(\d+)/g)].map((match) => match[1] ?? values[Number(match[2]) - 1]);
}

/**
 * Reads the immediately ending and the expires_at ending states from the
 * compiled maintenance selection {text, values}.
 */
function maintenanceStates({ text, values = [] }) {
  const immediate = [];
  const expiring = [];
  for (const match of text.matchAll(/\bstate\s+IN\s*\(([^)]*)\)(\s*AND\s+expires_at\s*<\s*\$\d+)?/gi))
    (match[2] ? expiring : immediate).push(listItems(match[1], values));
  const shape = 'the shape of maintenanceSelections.transfers in scripts/selfhost.mjs changed; adapt tests/integration/selfhost-transfer-states.mjs';
  assert.equal(immediate.length, 1, `expected one state IN (...) without an expires_at condition: ${shape}`);
  assert.equal(expiring.length, 1, `expected one state IN (...) followed by AND expires_at < $n: ${shape}`);
  assert.ok(immediate[0].length > 0, `the immediately ending state list is empty: ${shape}`);
  assert.ok(expiring[0].length > 0, `the expires_at ending state list is empty: ${shape}`);
  for (const [name, list] of [['immediately ending', immediate[0]], ['expires_at ending', expiring[0]]])
    assert.ok(!list.includes(finalState), `'${finalState}' is the cleared final state and must not be in the ${name} states of maintenance`);
  for (const state of immediate[0])
    assert.ok(!expiring[0].includes(state), `transfer state '${state}' is both immediately ending and ending through expires_at in maintenance`);
  return { immediate: immediate[0], expiring: expiring[0] };
}

// --- SQL units --------------------------------------------------------------

const opaque = '\u0001';
const lineAt = (text, offset) => text.slice(0, offset).split('\n').length;

/** Replaces escapes with same-length text so offsets keep pointing at the source. */
function unescapeRaw(raw) {
  return raw.replace(/\\(['"`$])/g, ' $1').replace(/\\[^]/g, '  ');
}

/** JS string and template literals; each ${...} becomes an opaque run of the same length. */
function sourceUnits(file) {
  const kind = file.path.endsWith('.tsx') ? ts.ScriptKind.TSX : /\.m?js$/.test(file.path) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true, kind);
  const units = [];
  const add = (node, text) => units.push({ text, line: (offset) => source.getLineAndCharacterOfPosition(node.getStart(source) + offset).line + 1 });
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const raw = file.text.slice(node.getStart(source), node.end);
      add(node, ' ' + unescapeRaw(raw.slice(1, -1)) + ' ');
    } else if (ts.isTemplateExpression(node)) {
      const start = node.getStart(source);
      const chars = unescapeRaw(file.text.slice(start, node.end)).split('');
      chars[0] = ' ';
      chars[chars.length - 1] = ' ';
      let open = node.head.end - 2;
      for (const span of node.templateSpans) {
        const close = span.literal.getStart(source) + 1;
        for (let index = open; index < close; index++) chars[index - start] = file.text[index] === '\n' ? '\n' : opaque;
        open = span.literal.end - 2;
      }
      add(node, chars.join(''));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return units;
}

/** SQL statements, split at --> statement-breakpoint and ';'. Comments are blanked. */
function sqlUnits(file) {
  const text = file.text;
  const units = [];
  let chars = [];
  let start = 0;
  const flush = (next) => {
    const base = start;
    units.push({ text: chars.join(''), line: (offset) => lineAt(text, base + offset) });
    chars = [];
    start = next;
  };
  for (let index = 0; index < text.length;) {
    if (text.startsWith('--> statement-breakpoint', index)) {
      flush(index + '--> statement-breakpoint'.length);
      index = start;
    } else if (text.startsWith('--', index) || text.startsWith('/*', index)) {
      const end = text.startsWith('--', index) ? (text.indexOf('\n', index) + 1 || text.length) : (text.indexOf('*/', index) + 2 || text.length);
      for (; index < end; index++) chars.push(text[index] === '\n' ? '\n' : ' ');
    } else if (text[index] === "'") {
      let end = index + 1;
      while (end < text.length && !(text[end] === "'" && text[end + 1] !== "'")) end += text[end] === "'" ? 2 : 1;
      chars.push(...text.slice(index, end + 1));
      index = end + 1;
    } else if (text[index] === ';') {
      flush(index + 1);
      index++;
    } else chars.push(text[index++]);
  }
  flush(text.length);
  return units;
}

// --- SQL unit analysis ------------------------------------------------------

const keywords = new Set(['where', 'set', 'on', 'join', 'left', 'right', 'inner', 'outer', 'cross', 'full', 'natural', 'group', 'order',
  'limit', 'values', 'select', 'as', 'using', 'union', 'except', 'intersect', 'having', 'returning', 'default', 'from', 'into', 'update',
  'or', 'and', 'not', 'in', 'is', 'by', 'window', 'do', 'conflict', 'offset', 'delete', 'insert', 'exists', 'case', 'when', 'then', 'else', 'end']);

function tokenize(text) {
  const tokens = [];
  for (let index = 0; index < text.length;) {
    const char = text[index];
    if (/\s/.test(char)) { index++; continue; }
    const start = index;
    if (char === opaque) {
      while (text[index] === opaque || text[index] === '\n') index++;
      tokens.push({ type: 'opaque', pos: start });
    } else if (char === "'") {
      let value = '';
      index++;
      while (index < text.length) {
        if (text[index] === "'" && text[index + 1] === "'") { value += "'"; index += 2; }
        else if (text[index] === "'") { index++; break; }
        else value += text[index++];
      }
      tokens.push({ type: 'string', value, pos: start });
    } else if (char === '"' || char === '`' || char === '[') {
      const close = char === '[' ? ']' : char;
      const end = text.indexOf(close, index + 1);
      if (end < 0) { index++; continue; }
      tokens.push({ type: 'ident', value: text.slice(index + 1, end).toLowerCase(), quoted: true, pos: start });
      index = end + 1;
    } else if (/[A-Za-z_]/.test(char)) {
      while (index < text.length && /[\w$]/.test(text[index])) index++;
      tokens.push({ type: 'ident', value: text.slice(start, index).toLowerCase(), pos: start });
    } else if (char === '?' || (char === '$' && /\d/.test(text[index + 1] ?? ''))) {
      index++;
      while (/\d/.test(text[index] ?? '')) index++;
      tokens.push({ type: 'param', pos: start });
    } else {
      const two = text.slice(index, index + 2);
      const value = ['<>', '!=', '==', '<=', '>=', '||'].includes(two) ? two : char;
      index += value.length;
      tokens.push({ type: 'op', value, pos: start });
    }
  }
  return tokens;
}

const isWord = (token, word) => token?.type === 'ident' && !token.quoted && token.value === word;
const isName = (token) => token?.type === 'ident' && (token.quoted || !keywords.has(token.value));
const isOp = (token, value) => token?.type === 'op' && token.value === value;

/** Table references: FROM|JOIN|UPDATE|INTO <name> [[AS] alias]. */
function tableReferences(tokens) {
  const references = [];
  for (let index = 0; index < tokens.length; index++) {
    const word = ['from', 'join', 'update', 'into'].find((candidate) => isWord(tokens[index], candidate));
    if (!word) continue;
    let next = index + 1;
    if (word === 'update' && isWord(tokens[next], 'or')) next += 2;
    if (!isName(tokens[next]) || isOp(tokens[next + 1], '.')) continue;
    const reference = { index, nameIndex: next, word, table: tokens[next].value };
    let aliasIndex = next + 1;
    if (isWord(tokens[aliasIndex], 'as')) aliasIndex++;
    if (isName(tokens[aliasIndex]) && !isOp(tokens[aliasIndex + 1], '(')) reference.alias = tokens[aliasIndex].value;
    references.push(reference);
  }
  return references;
}

/** State literals on transfers and bound writers of transfers.state in one SQL unit. */
function analyzeUnit(unit) {
  const tokens = tokenize(unit.text);
  const references = tableReferences(tokens);
  if (!references.length) return { states: [], writer: null };
  const aliases = new Map(references.filter((reference) => reference.alias).map((reference) => [reference.alias, reference.table]));
  const referenceAt = new Map(references.map((reference) => [reference.index, reference]));
  const states = [];
  let writer = null;
  const markWriter = (token) => { writer ??= { line: unit.line(token.pos) }; };
  const frames = [{ table: null, clause: null, update: null }];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const frame = frames[frames.length - 1];
    if (isOp(token, '(')) { frames.push({ table: null, clause: null, update: null }); continue; }
    if (isOp(token, ')')) { if (frames.length > 1) frames.pop(); continue; }
    const reference = referenceAt.get(index);
    if (reference) {
      frame.table = reference.table;
      frame.clause = reference.word;
      if (reference.word === 'update') frame.update = reference.table;
      if (reference.word === 'into' && reference.table === 'transfers') markWriter(token);
      index = reference.nameIndex;
      continue;
    }
    if (token.type === 'ident' && !token.quoted && ['set', 'where', 'returning', 'values', 'select', 'on', 'group', 'order', 'limit'].includes(token.value)) {
      frame.clause = token.value;
      continue;
    }
    if (!isWord(token, 'state') || isOp(tokens[index + 1], '.')) continue;
    let table;
    if (isOp(tokens[index - 1], '.')) {
      const qualifier = tokens[index - 2];
      if (qualifier?.type !== 'ident') continue;
      table = aliases.get(qualifier.value) ?? qualifier.value;
    } else table = [...frames].reverse().find((candidate) => candidate.table)?.table;
    if (table !== 'transfers') continue;
    let next = index + 1;
    if (['=', '==', '<>', '!='].some((operator) => isOp(tokens[next], operator))) {
      if (tokens[next + 1]?.type === 'string') states.push({ state: tokens[next + 1].value, line: unit.line(tokens[next + 1].pos) });
      else if (['param', 'opaque'].includes(tokens[next + 1]?.type) && isOp(tokens[next], '=') && frame.clause === 'set' && frame.update === 'transfers') markWriter(token);
      continue;
    }
    if (isWord(tokens[next], 'not')) next++;
    if (!isWord(tokens[next], 'in') || !isOp(tokens[next + 1], '(')) continue;
    for (let item = next + 2; item < tokens.length && !isOp(tokens[item], ')'); item++)
      if (tokens[item].type === 'string') states.push({ state: tokens[item].value, line: unit.line(tokens[item].pos) });
  }
  return { states, writer };
}

const scanCache = new Map();

function scanFile(file) {
  const key = `${file.path}\0${file.text}`;
  if (!scanCache.has(key)) {
    const findings = [];
    const writers = [];
    for (const unit of file.path.endsWith('.sql') ? sqlUnits(file) : sourceUnits(file)) {
      const { states, writer } = analyzeUnit(unit);
      for (const finding of states) findings.push({ ...finding, path: file.path });
      if (writer) writers.push({ ...writer, path: file.path });
    }
    scanCache.set(key, { findings, writers });
  }
  return scanCache.get(key);
}

/** files: {path, text}[] -> transfer state findings {state, path, line} and dynamic writers {path, line}. */
function scanTransferStates(files) {
  const results = files.map(scanFile);
  return { findings: results.flatMap((result) => result.findings), writers: results.flatMap((result) => result.writers) };
}

// --- Bound writers ----------------------------------------------------------

function zodTransferStates(text) {
  const match = /transfers\s*:\s*z\.array\(\s*z\.object\(\s*\{[^]*?\bstate\s*:\s*z\.enum\(\s*\[([^\]]*)\]\s*\)/.exec(text);
  if (!match) return [];
  const line = lineAt(text, match.index + match[0].lastIndexOf('z.enum'));
  return literals(match[1]).map((state) => ({ state, line }));
}

/** The direction ternary interpolated into the state column of INSERT INTO transfers (sql tag). */
function insertDirectionStates(text) {
  const source = ts.createSourceFile('module.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const states = [];
  const visit = (node) => {
    if (ts.isTaggedTemplateExpression(node) && node.tag.getText(source) === 'sql' && ts.isTemplateExpression(node.template)) {
      const columns = /INSERT\s+INTO\s+transfers\s*\(([^)]*)\)\s*(?:SELECT|VALUES\s*\()\s*$/i.exec(node.template.head.text);
      const index = columns?.[1].split(',').map((column) => column.trim()).indexOf('state') ?? -1;
      // Every select item up to the state column is one interpolation.
      const leading = node.template.templateSpans.slice(0, index + 1);
      const argument = index >= 0 && leading.length === index + 1 && leading.slice(0, index).every((span) => /^\s*,\s*$/.test(span.literal.text)) ? leading[index].expression : undefined;
      if (argument && ts.isConditionalExpression(argument) && /^\w+\.direction\s*===\s*'upload'$/.test(argument.condition.getText(source))
        && ts.isStringLiteral(argument.whenTrue) && ts.isStringLiteral(argument.whenFalse))
        for (const branch of [argument.whenTrue, argument.whenFalse])
          states.push({ state: branch.text, line: source.getLineAndCharacterOfPosition(branch.getStart(source)).line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return states;
}

// Every dynamic writer of transfers.state (UPDATE transfers SET state=?, INSERT INTO transfers)
// is registered here with the place its bound states come from.
const boundWriterRegistry = [
  { path: 'lib/server/agent/agent-channel.ts', writers: 1, extract: zodTransferStates },
  { path: 'lib/server/devices/transfers.ts', writers: 1, extract: insertDirectionStates },
];

const registryHint = 'add it to boundWriterRegistry in tests/integration/selfhost-transfer-states.mjs and handle the bound states in maintenance (scripts/selfhost.mjs)';

/** Checks the writers against the registry and returns the bound states as findings. */
function checkBoundWriters(files, writers, registry = boundWriterRegistry) {
  const problems = [];
  const findings = [];
  const registered = new Map(registry.map((entry) => [entry.path, entry]));
  for (const writer of writers)
    if (!registered.has(writer.path))
      problems.push({ path: writer.path, line: writer.line, message: `${writer.path}:${writer.line}: unregistered dynamic transfer state writer; ${registryHint}.` });
  for (const file of files) {
    const entry = registered.get(file.path);
    if (!entry) continue;
    const own = writers.filter((writer) => writer.path === file.path);
    const lines = own.map((writer) => writer.line).join(',') || '1';
    if (own.length !== entry.writers)
      problems.push({ path: file.path, line: own[0]?.line ?? 1, message: `${file.path}:${lines}: expected ${entry.writers} dynamic transfer state writer(s), found ${own.length}; ${registryHint}.` });
    const states = entry.extract(file.text);
    if (!states.length)
      problems.push({ path: file.path, line: own[0]?.line ?? 1, message: `${file.path}:${lines}: the registry extractor found no bound transfer states; ${registryHint}.` });
    for (const state of states) findings.push({ ...state, path: file.path });
  }
  return { problems, findings };
}

// --- Main check -------------------------------------------------------------

const maintenanceSelection = () => { const { text, params } = compile(maintenanceSelections.transfers(0, 1)); return { text, values: params }; };

function knownStates() {
  const { immediate, expiring } = maintenanceStates(maintenanceSelection());
  return new Set([...immediate, ...expiring, finalState]);
}

/** Transfer states found in the code that maintenance does not handle, with all locations. */
function unhandledStates(findings, known = knownStates()) {
  const missing = new Map();
  for (const finding of findings) {
    if (known.has(finding.state)) continue;
    if (!missing.has(finding.state)) missing.set(finding.state, []);
    const location = `${finding.path}:${finding.line}`;
    if (!missing.get(finding.state).includes(location)) missing.get(finding.state).push(location);
  }
  return [...missing].map(([state, locations]) => ({
    state,
    locations,
    message: `Transfer state '${state}' is not handled by maintenance: add it to expiringTransferStates or to the immediately ending states in scripts/selfhost.mjs (${locations.join(', ')}).`,
  }));
}

function analyze(files) {
  const scan = scanTransferStates(files);
  const bound = checkBoundWriters(files, scan.writers);
  const findings = [...scan.findings, ...bound.findings];
  return { findings, writerProblems: bound.problems, unhandled: unhandledStates(findings) };
}

function readSources() {
  const files = [];
  const walk = (relative) => {
    if (!fs.existsSync(path.join(root, relative))) return;
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(child); }
      else if (sourceExtensions.has(path.extname(entry.name)) && !entry.name.endsWith('.d.ts'))
        files.push({ path: child, text: fs.readFileSync(path.join(root, child), 'utf8') });
    }
  };
  for (const directory of sourceDirectories) walk(directory);
  for (const name of fs.readdirSync(path.join(root, 'drizzle')).filter((entry) => entry.endsWith('.sql')))
    files.push({ path: `drizzle/${name}`, text: fs.readFileSync(path.join(root, 'drizzle', name), 'utf8') });
  return files;
}

let sources;
const realSources = () => (sources ??= readSources());
const stateSet = (files) => new Set(scanTransferStates(files).findings.map((finding) => finding.state));

// --- Tests ------------------------------------------------------------------

test('known transfer states come from maintenanceSelections', () => {
  const { immediate, expiring } = maintenanceStates(maintenanceSelection());
  assert.deepEqual(immediate, ['cancelled', 'failed']);
  assert.deepEqual(expiring, ['uploading', 'pending', 'ready', 'active', 'completed']);
  assert.throws(() => maintenanceStates({ text: "SELECT id FROM transfers WHERE state IN ('failed','expired') OR (state IN ('active') AND expires_at < $1)" }), /'expired' is the cleared final state/);
  assert.throws(() => maintenanceStates({ text: "SELECT id FROM transfers WHERE state IN ('failed') OR (state IN ($1,$2) AND expires_at < $3)", values: ['active', 'expired'] }), /'expired' is the cleared final state/);
  assert.throws(() => maintenanceStates({ text: "SELECT id FROM transfers WHERE state IN ('failed','active') OR (state IN ('active') AND expires_at < $1)" }), /'active' is both immediately ending and ending through expires_at/);
  assert.equal(new Set(immediate).size, immediate.length, 'immediately ending states are unique');
  assert.equal(new Set(expiring).size, expiring.length, 'expires_at ending states are unique');
  assert.throws(() => maintenanceStates({ text: 'SELECT id FROM transfers WHERE expires_at < $1' }), /shape of maintenanceSelections\.transfers/);
  assert.throws(() => maintenanceStates({ text: "SELECT id FROM transfers WHERE state IN ('failed') OR (state IN () AND expires_at < $1)" }), /shape of maintenanceSelections\.transfers/);
});

test('scanner attributes state literals to the transfers table', () => {
  const fixtures = [
    ['lib/a.ts', `q("UPDATE transfers SET state='paused' WHERE id=?")`, ['paused']],
    ['lib/b.ts', "const q = `SELECT id FROM transfers WHERE state IN ('pending','queued') AND server_id=${x}`;", ['pending', 'queued']],
    ['lib/c.ts', "const q = `SELECT t.id FROM transfers t JOIN servers s ON s.id=t.server_id WHERE s.revoked=1 AND t.state<>'archived'`;", ['archived']],
    ['lib/d.ts', `q("UPDATE jobs SET state='queued' WHERE id=?")`, []],
    ['lib/e.ts', `q("UPDATE jobs SET state='running' WHERE NOT EXISTS (SELECT 1 FROM terminal_sessions WHERE state IN ('opening','open')) AND NOT EXISTS (SELECT 1 FROM transfers WHERE state IN ('held'))")`, ['held']],
    ['lib/f.ts', `q("UPDATE transfers SET message=? WHERE id IN (SELECT transfer_id FROM transfer_chunks WHERE size>0) AND state='lost'")`, ['lost']],
    ['drizzle/9999_fixture.sql', "UPDATE jobs SET state = 'cancelled' WHERE state IN ('finishing');--> statement-breakpoint\nUPDATE transfers SET state = 'parked' WHERE principal LIKE 'x%';\n", ['parked']],
    ['lib/h.ts', "// don't touch state IN ('ghost') FROM transfers\nq('SELECT id FROM transfers WHERE id=?');", []],
  ];
  for (const [file, text, expected] of fixtures)
    assert.deepEqual(stateSet([{ path: file, text }]), new Set(expected), `${file}: ${text}`);
  // Spacing, NOT IN and != variants; transfer_chunks is not transfers.
  assert.deepEqual(stateSet([{ path: 'lib/i.ts', text: "q(\"SELECT 1 FROM transfers AS x WHERE x.state NOT IN ( 'a' , 'b' ) AND state != 'c' AND transfers.state\\n= 'd'\")" }]), new Set(['a', 'b', 'c', 'd']));
  assert.deepEqual(stateSet([{ path: 'lib/j.ts', text: "q(\"SELECT 1 FROM transfer_chunks WHERE state='x'\")" }]), new Set());
  const [finding] = scanTransferStates([{ path: 'lib/k.ts', text: "const a = 1;\nconst q = `SELECT id\n FROM transfers WHERE state = 'late'`;" }]).findings;
  assert.deepEqual(finding, { state: 'late', path: 'lib/k.ts', line: 3 });
});

test('unregistered bound writers are reported', () => {
  const unregistered = [{ path: 'lib/new-writer.ts', text: 'export const q = `UPDATE transfers SET state=?,updated_at=? WHERE id=?`;' }];
  const scan = scanTransferStates(unregistered);
  assert.deepEqual(scan.writers, [{ path: 'lib/new-writer.ts', line: 1 }]);
  const { problems } = checkBoundWriters(unregistered, scan.writers);
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /^lib\/new-writer\.ts:1: unregistered dynamic transfer state writer; add it to boundWriterRegistry in tests\/integration\/selfhost-transfer-states\.mjs and handle the bound states in maintenance/);
  // A bound comparison in WHERE is not a writer, every INSERT INTO transfers is one,
  // and an interpolation of the sql tag counts as a bound value.
  assert.deepEqual(scanTransferStates([{ path: 'lib/x.ts', text: "q('SELECT id FROM transfers WHERE state=?')" }]).writers, []);
  assert.deepEqual(scanTransferStates([{ path: 'lib/x.ts', text: 'q(sql`SELECT id FROM transfers WHERE state=${state}`)' }]).writers, []);
  assert.equal(scanTransferStates([{ path: 'lib/x.ts', text: "q('INSERT INTO transfers (id,state) VALUES ($1,$2) ON CONFLICT DO NOTHING')" }]).writers.length, 1);
  assert.deepEqual(scanTransferStates([{ path: 'lib/y.ts', text: 'q(sql`UPDATE transfers SET state=${state},updated_at=${time} WHERE id=${id}`)' }]).writers, [{ path: 'lib/y.ts', line: 1 }]);

  const channel = realSources().find((file) => file.path === 'lib/server/agent/agent-channel.ts');
  const twice = [{ path: channel.path, text: `${channel.text}\nq(sql\`UPDATE transfers SET state=\${state} WHERE id=\${id}\`);\n` }];
  const counted = checkBoundWriters(twice, scanTransferStates(twice).writers);
  assert.equal(counted.problems.length, 1);
  assert.match(counted.problems[0].message, /^lib\/server\/agent\/agent-channel\.ts:\d+,\d+: expected 1 dynamic transfer state writer\(s\), found 2; add it to boundWriterRegistry/);
  const empty = checkBoundWriters([{ path: channel.path, text: 'export {};' }], []);
  assert.deepEqual(empty.problems.map((problem) => problem.message.replace(/;.*/, '')), [
    'lib/server/agent/agent-channel.ts:1: expected 1 dynamic transfer state writer(s), found 0',
    'lib/server/agent/agent-channel.ts:1: the registry extractor found no bound transfer states',
  ]);
});

test('every transfer state in the code is handled by maintenance', () => {
  const files = realSources();
  for (const entry of boundWriterRegistry) assert.ok(files.some((file) => file.path === entry.path), `${entry.path} is registered in boundWriterRegistry but does not exist; update the registry`);
  assert.ok(!files.some((file) => file.path.startsWith('tests/')), 'tests/ is not scanned');
  const { writerProblems, unhandled, findings } = analyze(files);
  assert.deepEqual(writerProblems.map((problem) => problem.message), []);
  assert.deepEqual(unhandled.map((entry) => entry.message), []);
  const bound = (file) => new Set(checkBoundWriters(files.filter((source) => source.path === file), []).findings.map((finding) => finding.state));
  assert.deepEqual(bound('lib/server/agent/agent-channel.ts'), new Set(['active', 'completed', 'failed']));
  assert.deepEqual(bound('lib/server/devices/transfers.ts'), new Set(['uploading', 'pending']));
  for (const finding of checkBoundWriters(files, []).findings) assert.ok(findings.some((entry) => entry.path === finding.path && entry.line === finding.line && entry.state === finding.state));
});

test('every maintenance state is found in the code', () => {
  const found = new Set(analyze(realSources()).findings.map((finding) => finding.state));
  const { immediate, expiring } = maintenanceStates(maintenanceSelection());
  for (const state of [...immediate, ...expiring, finalState])
    assert.ok(found.has(state), `Transfer state '${state}' from maintenance is never used in the code; check scripts/selfhost.mjs for a typo or a removed state`);
});

test('mutations of the real code are caught', () => {
  const mutate = (file, change) => {
    const files = realSources();
    const original = files.find((source) => source.path === file);
    assert.ok(original, `${file} is missing; adapt the mutation probe`);
    const text = change(original.text);
    assert.notEqual(text, original.text, `the search text of the mutation probe for ${file} is missing in the real code; adapt the mutation probe`);
    return analyze(files.map((source) => (source === original ? { path: file, text } : source)));
  };
  const replace = (search, replacement) => (text) => (text.includes(search) ? text.replace(search, replacement) : text);
  const expectUnhandled = (result, state, file) => {
    assert.deepEqual(result.writerProblems, []);
    assert.deepEqual(result.unhandled.map((entry) => entry.state), [state]);
    assert.ok(result.unhandled[0].locations.length > 0 && result.unhandled[0].locations.every((location) => location.startsWith(`${file}:`)), result.unhandled[0].message);
    assert.match(result.unhandled[0].message, new RegExp(`^Transfer state '${state}' is not handled by maintenance: add it to expiringTransferStates or to the immediately ending states in scripts/selfhost\\.mjs \\(${file.replace(/[./]/g, '\\$&')}:\\d+`));
  };

  expectUnhandled(mutate('lib/server/devices/transfers.ts', replace("UPDATE transfers SET state='completed'", "UPDATE transfers SET state='verified'")), 'verified', 'lib/server/devices/transfers.ts');
  expectUnhandled(mutate('lib/server/agent/agent-channel.ts', replace("z.enum(['active','completed','failed'])", "z.enum(['active','completed','failed','paused'])")), 'paused', 'lib/server/agent/agent-channel.ts');
  expectUnhandled(mutate('lib/server/devices/transfers.ts', replace("'uploading':'pending'", "'uploading':'queued'")), 'queued', 'lib/server/devices/transfers.ts');

  const appended = mutate('lib/server/devices/device-lifecycle.ts', (text) => `${text}\nq(sql\`UPDATE transfers SET state=\${state} WHERE id=\${id}\`);\n`);
  assert.deepEqual(appended.unhandled, []);
  assert.equal(appended.writerProblems.length, 1);
  assert.equal(appended.writerProblems[0].path, 'lib/server/devices/device-lifecycle.ts');
  assert.match(appended.writerProblems[0].message, /^lib\/server\/devices\/device-lifecycle\.ts:\d+: unregistered dynamic transfer state writer/);
});
