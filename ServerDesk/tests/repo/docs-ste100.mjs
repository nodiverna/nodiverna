import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { repositoryRoot } from '../support/paths.mjs';

// The documentation is English after ASD-STE100 (CONTRIBUTING.md, "Writing
// documentation"). This test checks the measurable rules: sentence and
// paragraph length, no German outside code, no German in bold portal labels,
// no contractions, and relative links. The docs quote the English portal text,
// so a German bold label is an error also in tables, headings and blockquotes.
// Vocabulary, active voice and the imperative are for review.
// It checks every Markdown file of the repository except license texts.
const repo = repositoryRoot;
const at = (relative) => path.join(repo, relative);
let checks = 0;
const check = (condition, label) => { assert.ok(condition, label); checks++; };

// Every Markdown file that git would commit (tracked or new, not ignored), but
// no license text. The ignore rules exclude the build tooling folder, .claude/, node_modules
// and the private overlay. Without git, a walk would read these folders, so
// the test fails instead.
function markdownFiles() {
  let listed;
  try {
    listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    throw new Error(`docs-ste100 needs git to list the Markdown files of the repository: ${error.message}`);
  }
  return [...new Set(listed.split('\0').filter(Boolean))]
    .filter((name) => /\.md$/i.test(name) && !/license/i.test(path.posix.basename(name)))
    .sort();
}
const documents = markdownFiles();

const STEP_SENTENCE_WORDS = 20;
const SENTENCE_WORDS = 25;
const PARAGRAPH_SENTENCES = 6;
const stopWords = ['und', 'oder', 'nicht', 'wird', 'werden', 'wurde', 'ist', 'sind', 'mit', 'für', 'der', 'das', 'dem', 'den', 'des', 'eine', 'einen', 'einem', 'auf', 'auch', 'sich', 'bei', 'nach', 'über', 'wenn', 'kann', 'muss', 'du', 'dein', 'deine', 'siehe'];
const contractions = ["it's", "that's", "there's", "you're", "we're", "they're", "i'm", "you'll", "we'll", "it'll", "you've", "we've", "let's"];
const wordEdge = (alternatives) => new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alternatives.join('|')})(?![\\p{L}\\p{N}_])`, 'iu');
const germanLetter = /[äöüÄÖÜß]/;
const stopWord = wordEdge(stopWords);
const contraction = wordEdge([String.raw`\p{L}*n['’]t`, ...contractions.map((word) => word.replace("'", "['’]"))]);
const isWord = (token) => /[\p{L}\p{N}]/u.test(token);

// A bold portal label looks German if it has a German letter, a German
// quotation mark, one strong word or two weak-word matches. Strong words are
// German UI words that English bold text does not use; weak words are short
// German words that are also English words, abbreviations or name particles
// (**Wernher von Braun**, **MIT License**), so one of them alone is not enough.
const weakLabelWords = ['von', 'zur', 'zum', 'frei', 'den', 'das', 'des', 'du', 'mit', 'ist'];
const germanLabelWords = [...stopWords,
  'warnung', 'kritisch', 'gerät', 'geräte', 'einstellungen', 'verwaltung', 'kunde', 'kunden', 'wartung', 'jetzt',
  'ausführen', 'prüfen', 'speichern', 'abbrechen', 'alle', 'gruppe', 'gruppen', 'zugriff', 'berechtigungen', 'lizenz',
  'treiber', 'ereignisse', 'weiter', 'weitere', 'hinzufügen', 'agenten', 'alarme', 'alarmregeln', 'verwalten', 'aussetzen',
  'benutzerkonten', 'konten', 'konto', 'modus', 'seit', 'endet', 'standardkunde', 'dienste', 'sicherheit', 'probleme',
  'historie', 'hinweise', 'beschreibung', 'zertifikate', 'starten', 'quittieren', 'widerrufen', 'stummschalten',
  'vorschau', 'anzeigen', 'erholt', 'geerbt', 'mein', 'keine', 'neuer', 'neuen', 'inventar', 'abfragen',
  'fernzugriff', 'speicher', 'akku', 'gesundheit', 'automatisierung', 'schwachstellen', 'fehlgeschlagen',
  'unbekannt', 'deaktiviert', 'anmelden', 'anmeldung', 'einrichten', 'verwenden', 'bestätigen', 'entfernen',
  'frei', 'komponenten', 'importe', 'rollen', 'rollenkatalog', 'startseite', 'schwellenwert', 'mindestdauer',
  'erholungsabstand', 'arbeit', 'betroffen', 'beliebiger', 'wert', 'daten', 'nutzungsdaten', 'senden', 'supportstatus',
  'regel', 'ausgeschaltet', 'technikerzugriff', 'teilweise', 'installiert', 'installierte', 'bibliothek', 'lokal',
  'angepasst', 'gemerkte', 'altes', 'noch', 'gesetzt', 'stummschaltung', 'aufheben', 'zur', 'zum', 'von', 'ohne',
  'kein', 'zeigen', 'folgt', 'qr-code',
];
const strongLabelWord = wordEdge(germanLabelWords.filter((word) => !weakLabelWords.includes(word)));
const weakLabelWord = new RegExp(wordEdge(weakLabelWords).source, 'giu');
const germanMark = /[äöüÄÖÜß„“]/;
const looksGerman = (label) => germanMark.test(label) || strongLabelWord.test(label) || (label.match(weakLabelWord) ?? []).length >= 2;

// Inline code, links, bold and bare URLs are replaced before the count. Each
// replacement keeps the line breaks of what it replaces, so a token's line is
// the number of line breaks before it.
const keepBreaks = (match) => '\n'.repeat(match.split('\n').length - 1);
function flatten(text) {
  return text
    .replace(/(`+)[\s\S]*?\1/g, (match) => `\u0001C${keepBreaks(match)}`)
    .replace(/!?\[([^\]]*)\]\(([^)]*)\)/g, (match, label, target) => `${label}${keepBreaks(target)}`)
    .replace(/\*\*[\s\S]+?\*\*/g, (match) => `\u0001B${keepBreaks(match)}`)
    .replace(/(?:https?|mailto):[^\s)>\]]*[^\s)>\].,:;!?]/gi, '\u0001U');
}

// A line that starts with an HTML tag, like `<p align="center">`, `<img …>` or
// `</picture>`. Its text between the tags is not checked.
const htmlLine = /^<\/?[a-z][a-z0-9-]*(?=[\s>/]|$)/i;

// Splits a Markdown text into units: one list item with its indented lines, or
// one paragraph. Fenced code, HTML comments, tables, headings, HTML lines and
// blank lines are no units. A unit is { numbered, lines: [{ line, text }] }.
function units(text) {
  const result = [];
  let current = null;
  let item = null; // the last list item, for indented paragraphs after a blank line
  let fence = null;
  let comment = false;
  const close = () => { if (current) result.push(current); current = null; };
  text.replaceAll('\r\n', '\n').split('\n').forEach((raw, index) => {
    const line = index + 1;
    let source = raw;
    if (fence) {
      const end = source.trim().match(/^(`{3,}|~{3,})\s*$/);
      if (end && end[1][0] === fence[0] && end[1].length >= fence.length) fence = null;
      return;
    }
    const open = source.match(/^\s*(`{3,}|~{3,})/);
    if (open) { close(); fence = open[1]; return; }
    // HTML comments, also over several lines, but not inside inline code.
    const masked = source.replace(/(`+)[\s\S]*?\1/g, (match) => ' '.repeat(match.length));
    let position = 0;
    let kept = '';
    if (comment) {
      const end = masked.indexOf('-->');
      if (end === -1) return;
      comment = false;
      position = end + 3;
    }
    for (;;) {
      const start = masked.indexOf('<!--', position);
      if (start === -1) { kept += source.slice(position); break; }
      kept += source.slice(position, start);
      const end = masked.indexOf('-->', start + 4);
      if (end === -1) { comment = true; break; }
      position = end + 3;
    }
    source = kept.replace(/^(\s*)>\s?/, '$1');
    const trimmed = source.trim();
    if (!trimmed) { close(); return; }
    if (trimmed.startsWith('|') || /^#{1,6}(\s|$)/.test(trimmed) || htmlLine.test(trimmed)) { close(); item = null; return; }
    const marker = source.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
    if (marker) {
      close();
      item = { numbered: /\d/.test(marker[2]), indent: marker[1].length };
      current = { numbered: item.numbered, lines: [{ line, text: marker[3] }] };
      return;
    }
    const indent = source.length - source.trimStart().length;
    if (current) { current.lines.push({ line, text: trimmed }); return; }
    if (item && indent > item.indent) { current = { numbered: item.numbered, lines: [{ line, text: trimmed }] }; return; }
    item = null;
    current = { numbered: false, lines: [{ line, text: trimmed }] };
  });
  close();
  return result;
}

// The text without fenced code, HTML comments and inline code. Each removed
// character becomes a space, so lines and columns stay the same.
function prose(text) {
  let fence = null;
  let comment = false;
  return text.replaceAll('\r\n', '\n').split('\n').map((raw) => {
    if (fence) {
      const end = raw.trim().match(/^(`{3,}|~{3,})\s*$/);
      if (end && end[1][0] === fence[0] && end[1].length >= fence.length) fence = null;
      return '';
    }
    const open = raw.match(/^\s*(`{3,}|~{3,})/);
    if (open) { fence = open[1]; return ''; }
    const masked = raw.replace(/(`+)[\s\S]*?\1/g, (match) => ' '.repeat(match.length));
    let kept = '';
    let position = 0;
    if (comment) {
      const end = masked.indexOf('-->');
      if (end === -1) return '';
      comment = false;
      kept = ' '.repeat(end + 3);
      position = end + 3;
    }
    for (;;) {
      const start = masked.indexOf('<!--', position);
      if (start === -1) { kept += masked.slice(position); break; }
      kept += masked.slice(position, start);
      const end = masked.indexOf('-->', start + 4);
      if (end === -1) { comment = true; break; }
      kept += ' '.repeat(end + 3 - start);
      position = end + 3;
    }
    return kept;
  }).join('\n');
}

// Bold spans outside code and comments, in every kind of line: prose, list
// items, tables, headings and blockquotes. A span can go over line breaks,
// but not over a blank line.
function germanLabels(text) {
  const errors = [];
  const masked = prose(text);
  for (const match of masked.matchAll(/\*\*((?:[^*\n]|\*(?!\*)|\n(?![^\S\n]*\n))+?)\*\*/g)) {
    const label = match[1].replace(/\s+/g, ' ').trim();
    if (looksGerman(label)) errors.push({ line: masked.slice(0, match.index).split('\n').length, label });
  }
  return errors;
}

function checkMarkdown(text, file) {
  const errors = [];
  const report = (line, message) => errors.push({ file, line, message });
  for (const { line, label } of germanLabels(text)) report(line, `German UI label "${label}"`);
  for (const unit of units(text)) {
    const first = unit.lines[0].line;
    const flat = flatten(unit.lines.map((entry) => entry.text).join('\n'));
    flat.split('\n').forEach((content, offset) => {
      const { line } = unit.lines[offset];
      if (germanLetter.test(content)) report(line, `German letter "${content.match(germanLetter)[0]}"`);
      const german = content.match(stopWord);
      if (german) report(line, `German word "${german[0]}"`);
      const short = content.match(contraction);
      if (short) report(line, `contraction "${short[0]}"`);
    });
    // The flattened unit keeps every line break, so the n-th break starts unit line n.
    const sentences = [];
    let sentence = null;
    let lineIndex = 0;
    for (const token of flat.split(/(\s+)/)) {
      if (/^\s*$/.test(token)) { lineIndex += token.split('\n').length - 1; continue; }
      if (isWord(token)) {
        sentence ??= { line: unit.lines[lineIndex]?.line ?? first, words: 0 };
        sentence.words++;
      }
      if (/[.!?:]$/.test(token) && sentence) { sentences.push(sentence); sentence = null; }
    }
    if (sentence) sentences.push(sentence);
    const limit = unit.numbered ? STEP_SENTENCE_WORDS : SENTENCE_WORDS;
    for (const { line, words } of sentences)
      if (words > limit) report(line, `sentence has ${words} words (limit ${limit}${unit.numbered ? ' in a numbered step' : ''})`);
    if (sentences.length > PARAGRAPH_SENTENCES) report(first, `paragraph has ${sentences.length} sentences (limit ${PARAGRAPH_SENTENCES})`);
  }
  return errors.sort((a, b) => a.line - b.line);
}

// GitHub heading anchors: lower case, only letters, digits, spaces, "-" and
// "_", spaces become "-", repeated slugs get "-1", "-2".
function slug(heading) {
  return heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M} _-]/gu, '')
    .replaceAll(' ', '-');
}

function anchors(text) {
  const seen = new Map();
  const result = new Set();
  let fence = null;
  for (const line of text.replaceAll('\r\n', '\n').split('\n')) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) { if (marker && marker[1][0] === fence[0] && line.trim().length === marker[1].length && marker[1].length >= fence.length) fence = null; continue; }
    if (marker) { fence = marker[1]; continue; }
    const heading = line.match(/^#{1,6}\s+(.*?)\s*#*\s*$/);
    if (!heading) continue;
    const base = slug(heading[1]);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    result.add(count ? `${base}-${count}` : base);
  }
  return result;
}

// Relative links outside code: the target exists, and an anchor into a
// checked Markdown file matches one of its headings.
function checkLinks(file) {
  const errors = [];
  const text = fs.readFileSync(at(file), 'utf8').replaceAll('\r\n', '\n');
  const prose = text
    .replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1[^\S\n]*$/gm, (match) => keepBreaks(match))
    .replace(/(`+)[\s\S]*?\1/g, (match) => `C${keepBreaks(match)}`);
  for (const match of prose.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const target = match[1];
    if (/^(https?|mailto):/i.test(target)) continue;
    const line = prose.slice(0, match.index).split('\n').length;
    const [pathPart, anchor] = target.split('#');
    const resolved = pathPart ? path.posix.join(path.posix.dirname(file), decodeURIComponent(pathPart)) : file;
    if (!fs.existsSync(at(resolved))) { errors.push(`${file}:${line}: link target ${target} does not exist`); continue; }
    if (anchor === undefined || !documents.includes(resolved)) continue;
    if (!anchors(fs.readFileSync(at(resolved), 'utf8')).has(decodeURIComponent(anchor)))
      errors.push(`${file}:${line}: anchor #${anchor} matches no heading in ${resolved}`);
  }
  return errors;
}

// 1. Self-test of checkMarkdown with small texts.
const words = (count, end = '.') => `${Array.from({ length: count }, (_, index) => `word${index + 1}`).join(' ')}${end}`;
const only = (text, line, pattern, label) => {
  const errors = checkMarkdown(text, 'sample.md');
  check(errors.length === 1, `${label}: exactly one error, got ${JSON.stringify(errors)}`);
  check(errors[0].line === line && errors[0].file === 'sample.md', `${label}: error on line ${line}, got ${errors[0].line}`);
  check(pattern.test(errors[0].message), `${label}: message ${errors[0].message} matches ${pattern}`);
};
const clean = [
  '# Title with Umlaut ä und mehr',
  '',
  'Open the **Add device** page. The portal shows `Ein Gerät kann nur einer Gerätegruppe angehören`.',
  'See [the guide](docs/guide.md#über-uns) and https://example.com/und/für.',
  '',
  '1. Open the page.',
  '2. Select **Save**.',
  '',
  '| Feld | Inhalt und mehr |',
  '| --- | --- |',
  '',
  '<!-- Kommentar und für -->',
  '```powershell',
  `# ${words(40)} und für ä`,
  '```',
  '',
  `> ${words(25)}`,
].join('\n');
check(checkMarkdown(clean, 'sample.md').length === 0, `a compliant text has no errors: ${JSON.stringify(checkMarkdown(clean, 'sample.md'))}`);
only(`Intro.\n\n${words(26)}`, 3, /26 words \(limit 25\)/, '26-word sentence');
only(`Steps:\n\n1. Open it.\n2. ${words(21)}`, 4, /21 words \(limit 20 in a numbered step\)/, '21-word sentence in a numbered step');
only(`Intro.\n\nOne. Two. Three.\nFour. Five. Six. Seven.`, 3, /7 sentences \(limit 6\)/, 'paragraph with 7 sentences');
only('First line.\nThe Gerät is ready.', 2, /German letter "ä"/, 'umlaut');
only('First line.\n\nCopy und paste.', 3, /German word "und"/, 'stop word und');
only('First line.\nSecond line.\nYou don\'t need it.', 3, /contraction "don't"/, 'contraction');
check(checkMarkdown(words(25), 'sample.md').length === 0, 'a sentence with 25 words passes');
check(checkMarkdown(`1. ${words(20)}`, 'sample.md').length === 0, 'a numbered step with 20 words passes');
check(checkMarkdown('Check `Wird geladen für dich` and `Konten`.', 'sample.md').length === 0, 'German in inline code passes');
only('First line.\nOpen **Identität und Zugriff** and check it.', 2, /^German UI label "Identität und Zugriff"$/, 'German in bold fails');
only('Intro.\n\nOpen **Gerät hinzufügen**.', 3, /^German UI label "Gerät hinzufügen"$/, 'German bold label with an umlaut');
only('Set **Warnung**.', 1, /^German UI label "Warnung"$/, 'German bold label from the word list');
only('Intro.\n\n| Area | Text |\n| --- | --- |\n| **Überblick** | text |', 5, /^German UI label "Überblick"$/, 'German bold label in a table');
only('Intro.\n\n## The **Wartung** page', 3, /^German UI label "Wartung"$/, 'German bold label in a heading');
only('Intro.\n\n> Open **Kunden** first.', 3, /^German UI label "Kunden"$/, 'German bold label in a blockquote');
only('Intro.\n\n- Open **Alle Geräte**.', 3, /^German UI label "Alle Geräte"$/, 'German bold label in a list item');
only('Intro.\n\nThe portal shows **„Fertig“**.', 3, /^German UI label "„Fertig“"$/, 'German quotation marks in bold');
check(checkMarkdown('Open **Warning**, **Run now**, **Status unknown**, **Software.**, **Settings → Customers**, **Owner** and **Status**.', 'sample.md').length === 0, 'English bold labels pass');
// One weak word (von, zur, zum, frei, den, das, des, du, mit, ist) alone is no German label.
for (const label of ['Wernher von Braun', 'Frei Otto', 'MIT License', 'DAS volumes', 'IST time zone', 'Den of thieves']) {
  const findings = checkMarkdown(`Intro.\n\nSee **${label}**.`, 'sample.md');
  check(findings.length === 0, `English bold text with one weak word passes: ${label} ${JSON.stringify(findings)}`);
}
only('Intro.\n\nOpen **Speicher frei**.', 3, /^German UI label "Speicher frei"$/, 'a strong word with a weak word is German');
only('Intro.\n\nOpen **Zur Startseite**.', 3, /^German UI label "Zur Startseite"$/, 'a weak word with a strong word is German');
only('Intro.\n\nThe portal shows **Das ist frei**.', 3, /^German UI label "Das ist frei"$/, 'three weak words are German');
const hidden = 'Run this:\n\n```md\nOpen **Gerät**.\n```\n\nUse `**Gerät**` here. <!-- **Wartung** -->\n<!--\n**Kunden**\n-->';
check(checkMarkdown(hidden, 'sample.md').length === 0, `German bold in fenced code, inline code and HTML comments passes: ${JSON.stringify(checkMarkdown(hidden, 'sample.md'))}`);
check(checkMarkdown(`Run this:\n\n\`\`\`sh\n${words(40)} und für\n\`\`\`\n`, 'sample.md').length === 0, 'a sentence in a code block passes');
check(checkMarkdown('Use `<!--` to open a comment and und. -->', 'sample.md').length === 1, 'a comment marker in inline code opens no comment');
check(checkMarkdown('Text before. <!-- und\nmehr und -->Text after.', 'sample.md').length === 0, 'a comment over two lines is skipped');
check(checkMarkdown(`- Item one.\n  ${words(24)}\n- ${words(25)}`, 'sample.md').length === 0, 'bullet items allow 25 words per sentence');
check(checkMarkdown(`${words(15, ':')} ${words(15)}`, 'sample.md').length === 0, 'a colon ends a sentence');
check(checkMarkdown(`See https://example.com/a. ${words(24)}`, 'sample.md').length === 0, 'a full stop after a URL ends the sentence');
// HTML lines are no units, like the centered header of README.md.
const badge = (index) => `<a href="https://example.com/${index}"><img src="https://example.com/badge${index}.svg" alt="Badge ${index} with a long alternative text und für"></a>`;
const header = ['<p align="center">', `  ${[1, 2, 3].map(badge).join(' ')}`, '</p>', '', '<picture>', '  <source media="(prefers-color-scheme: dark)" srcset="dark.png">', '</picture>'].join('\n');
check(checkMarkdown(header, 'sample.md').length === 0, `HTML lines with more than 25 tokens and no full stop pass: ${JSON.stringify(checkMarkdown(header, 'sample.md'))}`);
only(`<p align="center">\n  <img src="logo.svg" alt="Logo">\n</p>\n\n${words(26)}`, 5, /26 words \(limit 25\)/, 'a prose line after an HTML block is still checked');
check(checkMarkdown('<https://example.com/a> und more.', 'sample.md').length === 1, 'an autolink starts no HTML line');

// 2. The GitHub slug rule.
check(slug('Contributor agreement') === 'contributor-agreement', '"## Contributor agreement" has the slug contributor-agreement');
check(slug('`LICENSE_SERVER_URL`') === 'license_server_url', 'backticks vanish and underscores stay');
check(slug('Agent 4.7.0: SYSTEM broker') === 'agent-470-system-broker', 'punctuation vanishes');
check([...anchors('# A\n## Setup\n## Setup\n```\n## Setup\n```\n')].join(',') === 'a,setup,setup-1', 'repeated headings get -1 and code is no heading');

// 3. The file list: every Markdown file of the repository, no license text,
// nothing from the build tooling folder or .claude/.
for (const file of ['README.md', 'CONTRIBUTING.md', 'ServerDesk/docs/customers.md', 'ServerDesk/docs/self-hosting.md', 'ServerDesk/docs/native-agent-v4.md'])
  check(documents.includes(file), `the checked files include ${file}`);
check(!documents.includes('ServerDesk/vendor/shadcn-tailwind-4.13.0.LICENSE.md'), 'the license text of the shadcn vendor files is not checked');
const tooling = 'factory' + '/';
check(!documents.some((file) => file.startsWith(tooling) || file.startsWith('.claude/')), `no file under ${tooling} or .claude/ is checked: ${documents.filter((file) => /^(factory|\.claude)\//.test(file)).join(', ')}`);
check(documents.length >= 32, `at least 32 Markdown files are checked, got ${documents.length}`);
check(documents.every((file, index) => index === 0 || documents[index - 1] < file), 'the file list is sorted and has no duplicates');

// 4. Every checked file exists, follows the rules and has valid links.
// All findings of all files are listed at once.
const findings = [];
for (const file of documents) {
  check(fs.existsSync(at(file)), `${file} exists`);
  findings.push(...checkMarkdown(fs.readFileSync(at(file), 'utf8'), file).map(({ line, message }) => `${file}:${line}: ${message}`));
  findings.push(...checkLinks(file));
  checks += 2;
}
assert.deepEqual(findings, [], `the documentation breaks the writing rules (CONTRIBUTING.md, "Writing documentation"):\n${findings.join('\n')}`);

console.log(`${checks} documentation style checks passed.`);
