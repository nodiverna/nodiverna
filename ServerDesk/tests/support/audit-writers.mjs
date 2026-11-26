// A source scan for every literal audit action that a writer in lib/, ui/, app/api/, runtime/ and scripts/ can
// store (tests/ui/devices/audit-display.mjs): log() calls, the action of auditEvent, auditEachTarget, customerEntries
// and commitWithAudit entries, job audit rows ({actor,action,target}), wrappers that take an action
// parameter, `action=`/`auditAction=` assignments, INSERT INTO audit statements and the constant maps
// (`*AuditAction(s)`, `*Audit` objects and constants). Dynamic families (alert.*, agent.integrity.*, the
// operation labels, the DHCP and DNS labels) are not literals; the test checks them on its own.
import {readFileSync, readdirSync, statSync} from 'node:fs';
import path from 'node:path';

// ui/ holds the UI models that lived in lib/ before lib/server/, so the scan still covers them.
const roots = ['lib', 'ui', 'app/api', 'runtime', 'scripts'];
// A call of a free function: not part of a name and not a method (x.log), but a spread (...audit()) counts.
const callStart = String.raw`(?<![\w$])(?<!(?:^|[^.])\.)`;

function sourceFiles(root, dir) {
  const full = path.join(root, dir);
  let entries;
  try { entries = readdirSync(full); } catch { return []; }
  return entries.flatMap(name => {
    const relative = path.join(dir, name), absolute = path.join(root, relative);
    if (statSync(absolute).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(root, relative);
    return /\.(ts|tsx|mjs)$/.test(name) && !name.endsWith('.d.ts') ? [relative.replaceAll('\\', '/')] : [];
  });
}

/** The index after the bracket that closes the one at `open`, skipping strings, comments and template literals. */
function closing(text, open) {
  const pairs = {'(': ')', '{': '}', '[': ']'}, stack = [pairs[text[open]]];
  for (let index = open + 1; index < text.length; index++) {
    const char = text[index];
    if (char === "'" || char === '"') { index = skipString(text, index); continue; }
    if (char === '`') { index = skipTemplate(text, index); continue; }
    if (char === '/' && text[index + 1] === '/') { index = text.indexOf('\n', index); if (index < 0) return text.length; continue; }
    if (char === '/' && text[index + 1] === '*') { index = text.indexOf('*/', index) + 1; continue; }
    if (pairs[char]) stack.push(pairs[char]);
    else if (char === stack[stack.length - 1]) { stack.pop(); if (!stack.length) return index + 1; }
  }
  return text.length;
}
function skipString(text, start) {
  const quote = text[start];
  for (let index = start + 1; index < text.length; index++) {
    if (text[index] === '\\') { index++; continue; }
    if (text[index] === quote || text[index] === '\n') return index;
  }
  return text.length;
}
function skipTemplate(text, start) {
  for (let index = start + 1; index < text.length; index++) {
    if (text[index] === '\\') { index++; continue; }
    if (text[index] === '`') return index;
    if (text[index] === '$' && text[index + 1] === '{') index = closing(text, index + 1) - 1;
  }
  return text.length;
}
/** The parts of a list split at commas outside brackets, strings and templates. */
function topLevel(text, separator = ',') {
  const parts = [];
  let depth = 0, start = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "'" || char === '"') { index = skipString(text, index); continue; }
    if (char === '`') { index = skipTemplate(text, index); continue; }
    if ('({['.includes(char)) depth++;
    else if (')}]'.includes(char)) depth--;
    else if (char === separator && depth === 0) { parts.push(text.slice(start, index)); start = index + 1; }
  }
  parts.push(text.slice(start));
  return parts.map(part => part.trim());
}
/** The JS string literals of an expression (template literals only without placeholders). */
export function literals(expression) {
  const found = [];
  // Operands of a comparison and arguments of a method call (kind==='x', kind.startsWith('x')) are conditions, not actions.
  expression = expression
    .replace(/[!=]==?\s*(?:'[^'\n]*'|"[^"\n]*")/g, '')
    .replace(/(?:'[^'\n]*'|"[^"\n]*")\s*[!=]==?/g, '')
    .replace(/\.\w+\(\s*(?:'[^'\n]*'|"[^"\n]*")\s*\)/g, '');
  for (const match of expression.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`([^`$\\]*)`/g)) found.push(match[1] ?? match[2] ?? match[3]);
  return found;
}
/** The value of the top-level property `key` of an object literal text "{...}", or undefined. */
function property(objectText, key) {
  const inner = objectText.trim().replace(/^\{/, '').replace(/\}$/, '');
  for (const part of topLevel(inner)) {
    const match = new RegExp(`^${key}\\s*:\\s*([\\s\\S]*)$`).exec(part);
    if (match) return match[1];
  }
  return undefined;
}

/** Every literal action with the file that writes it: [{value, file, form}]. */
export function scanAuditActions(root) {
  const found = [];
  const add = (values, file, form) => { for (const value of values) if (value.trim()) found.push({value, file, form}); };
  for (const file of roots.flatMap(dir => sourceFiles(root, dir))) {
    const text = readFileSync(path.join(root, file), 'utf8');
    // log(actor, action, target[, serverIds]) of lib/server/context.ts.
    for (const match of text.matchAll(new RegExp(callStart + 'log\\(', 'g'))) {
      if (/function\s+$/.test(text.slice(Math.max(0, match.index - 12), match.index))) continue;
      const args = topLevel(text.slice(match.index + 4, closing(text, match.index + 3) - 1));
      if (args.length >= 3) add(literals(args[1]), file, 'log');
    }
    // auditEvent({...action...}), auditEachTarget({...}), customerEntries(scope, {...}).
    for (const match of text.matchAll(new RegExp(callStart + '(auditEvent|auditEachTarget|customerEntries)\\(', 'g'))) {
      const open = match.index + match[0].length - 1, args = topLevel(text.slice(open + 1, closing(text, open) - 1));
      const object = args.find(arg => arg.startsWith('{'));
      const value = object && property(object, 'action');
      if (value) add(literals(value), file, match[1]);
    }
    // commitWithAudit entries (audit:{...}) and job audit rows ({actor,action,target}).
    for (const match of text.matchAll(/\baudit:\{|\{actor:/g)) {
      const open = match.index + match[0].indexOf('{'), object = text.slice(open, closing(text, open));
      const value = property(object, 'action');
      if (value) add(literals(value), file, 'audit entry');
    }
    // Wrappers such as const commit=(statement,action:string,target)=>…auditEvent(…): the literal at the action's position.
    for (const match of text.matchAll(/const (\w+)=\(([^()]*)\)=>[^\n]*?(?:auditEvent|log)\(/g)) {
      const position = topLevel(match[2]).findIndex(parameter => /^action\s*:\s*string$/.test(parameter));
      if (position < 0) continue;
      for (const call of text.matchAll(new RegExp(callStart + match[1] + '\\(', 'g'))) {
        const open = call.index + call[0].length - 1, args = topLevel(text.slice(open + 1, closing(text, open) - 1));
        if (args[position] !== undefined) add(literals(args[position]), file, 'wrapper ' + match[1]);
      }
    }
    // action='…' / auditAction='…' assignments in files that write audit rows.
    if (/auditEvent\(|commitWithAudit\(|INSERT INTO audit/.test(text)) {
      // On the code only: an action= inside SQL text is a condition. The mask keeps every offset.
      const code = maskTemplates(text);
      for (const match of code.matchAll(/(?<![.\w])(?:action|auditAction)=(?!=)([^;\n]+);/g)) add(literals(text.slice(match.index + match[0].indexOf('=') + 1, match.index + match[0].length - 1)), file, 'assignment');
    }
    // INSERT INTO audit (…,action,…) VALUES(…) | SELECT …: the value at the action column.
    for (const match of text.matchAll(/INSERT INTO audit\s*\(([^)]*)\)\s*(VALUES\s*\(|SELECT\s)/g)) {
      const columns = match[1].split(',').map(column => column.trim()), position = columns.indexOf('action');
      const start = match.index + match[0].length;
      let list;
      if (match[2].startsWith('VALUES')) list = text.slice(start, closing(text, start - 1) - 1);
      else {
        // The select list ends before FROM or WHERE at depth 0, or at the end of the template.
        const end = skipTemplateEnd(text, start);
        const rest = text.slice(start, end), stop = /\s(FROM|WHERE)\s/.exec(maskNested(rest));
        list = stop ? rest.slice(0, stop.index) : rest;
      }
      const value = topLevel(list)[position];
      if (value === undefined) continue;
      const sqlLiteral = /^'([^']*)'$/.exec(value.trim());
      if (sqlLiteral) add([sqlLiteral[1]], file, 'insert');
      else add(literals(value.replace(/^\$\{|\}$/g, '')), file, 'insert');
    }
    // Constant maps and constants: *AuditAction(s), *Audit objects, crossCustomerAction.
    for (const match of text.matchAll(/(?:const|let)\s+(\w+)\s*(?::[^=]+)?=\s*(Object\.freeze\(\s*)?(\{[^{}]*\}|'[^']*')/g)) {
      if (!/AuditActions?$|^usageDataAudit$|^crossCustomerAction$|^auditSummaryAction$/i.test(match[1])) continue;
      const body = match[3];
      if (body.startsWith("'")) { add([body.slice(1, -1)], file, 'constant ' + match[1]); continue; }
      for (const part of topLevel(body.slice(1, -1))) {
        const pair = /^(\w+)\s*:\s*([\s\S]*)$/.exec(part);
        if (pair && pair[1] !== 'target') add(literals(pair[2]), file, 'constant ' + match[1]);
      }
    }
  }
  return found;
}
/** The end of the template literal that contains `start` (the next backtick at depth 0). */
function skipTemplateEnd(text, start) {
  for (let index = start; index < text.length; index++) {
    if (text[index] === '\\') { index++; continue; }
    if (text[index] === '`') return index;
    if (text[index] === '$' && text[index + 1] === '{') index = closing(text, index + 1) - 1;
  }
  return text.length;
}
/** The text with every bracketed part and ${…} replaced by spaces, so a FROM inside a subquery does not end the list. */
function maskNested(text) {
  let out = '', depth = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '$' && text[index + 1] === '{') { const end = closing(text, index + 1); out += ' '.repeat(end - index); index = end - 1; continue; }
    if (char === '(') depth++;
    out += depth ? ' ' : char;
    if (char === ')') depth--;
  }
  return out;
}

/** The text with the literal parts of every template literal replaced by spaces (the ${…} code stays), so SQL never reads as code. */
function maskTemplates(text) {
  let out = '';
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "'" || char === '"') { const end = skipString(text, index); out += text.slice(index, end + 1); index = end; continue; }
    if (char === '/' && text[index + 1] === '/') { const end = text.indexOf('\n', index); const stop = end < 0 ? text.length : end; out += ' '.repeat(stop - index); index = stop - 1; continue; }
    if (char !== '`') { out += char; continue; }
    out += '`';
    for (index++; index < text.length && text[index] !== '`'; index++) {
      if (text[index] === '\\') { out += '  '; index++; continue; }
      if (text[index] === '$' && text[index + 1] === '{') { const end = closing(text, index + 1); out += text.slice(index, end); index = end - 1; continue; }
      out += text[index] === '\n' ? '\n' : ' ';
    }
    out += '`';
  }
  return out;
}
