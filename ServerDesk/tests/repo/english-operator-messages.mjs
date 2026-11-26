// Operator, developer and agent output is English. The guard flags
// German text: an umlaut, ß, German quotation marks or a word from a German
// stop-word list. Operator files are checked in full; agent C# files only in
// their string literals. German stays in lib/i18n/messages/de.ts, in tests and
// in the seeded Owner role description (database data the RBAC UI shows).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const operatorFiles = [
  'scripts/selfhost.mjs', 'scripts/copy-tree.mjs', 'scripts/check-node-modules-links.mjs',
  'runtime/secret-keyring.mjs', 'runtime/maintenance.mjs', 'runtime/maintenance-scheduler.mjs', 'agent/v3/Install-ServerDesk-V3.template.ps1', 'agent/Uninstall-ServerDesk.ps1',
];
// The only allowed match: the Owner role description in selfhost.mjs.
const ownerDescription = "'Vollständiger Portal- und Gerätezugriff im zugewiesenen Geltungsbereich.'";

const stopWords = [
  'nicht', 'keine', 'kein', 'keinen', 'wurde', 'wurden', 'werden', 'wird', 'zuerst', 'prüfen', 'angeben', 'angegeben', 'oder', 'und', 'für',
  'ist', 'sind', 'eine', 'einen', 'einer', 'bitte', 'fehlgeschlagen', 'erfolgreich', 'ungültig', 'ungültige', 'ungültiger', 'ungültiges',
  'konnte', 'können', 'bereits', 'gelöscht', 'vorhanden', 'gefunden', 'erforderlich', 'neustart', 'gerät', 'datei', 'ordner', 'verbindung',
  'fehler', 'laufwerk', 'benutzer', 'dienst', 'dienste', 'verwenden', 'statt', 'liefert', 'nichts', 'aufruf', 'unbekannt', 'unbekannte',
  'unbekannter', 'fehlt', 'geändert', 'ausgeführt', 'abgebrochen', 'verfügbar', 'über', 'zum', 'zur', 'auf', 'bei', 'nach', 'von', 'vor',
  'netzwerk', 'prozesse', 'inventar', 'sicherheit', 'geplante', 'lokale', 'konten', 'rollen', 'aufgaben',
];
const german = new RegExp(String.raw`[äöüÄÖÜß„“]|(?<![\p{L}\p{N}_])(?:${stopWords.join('|')})(?![\p{L}\p{N}_])`, 'iu');

/** The lines of text that look German, as "line: text". */
export function germanLines(text) {
  return text.split(/\r?\n/).flatMap((line, index) => german.test(line) ? [`${index + 1}: ${line.trim().slice(0, 160)}`] : []);
}

/** Every string literal of a C# source (regular, verbatim, interpolated and raw) with its line. */
export function csharpLiterals(source) {
  const out = []; let i = 0, line = 1; const n = source.length;
  while (i < n) {
    const c = source[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === '/' && source[i + 1] === '/') { while (i < n && source[i] !== '\n') i++; continue; }
    if (c === '/' && source[i + 1] === '*') { i += 2; while (i < n && !(source[i] === '*' && source[i + 1] === '/')) { if (source[i] === '\n') line++; i++; } i += 2; continue; }
    if (c === "'") { i++; while (i < n && source[i] !== "'") { if (source[i] === '\\') i++; i++; } i++; continue; }
    let j = i, verbatim = false, interpolated = false;
    while (source[j] === '$' || source[j] === '@') { if (source[j] === '@') verbatim = true; else interpolated = true; j++; }
    if (source[j] === '"' && !/[A-Za-z0-9_]/.test(source[i - 1] ?? ' ')) {
      const start = line;
      if (source.startsWith('"""', j)) {
        let quotes = 0; while (source[j + quotes] === '"') quotes++;
        const end = '"'.repeat(quotes); let k = j + quotes, value = '';
        while (k < n && !source.startsWith(end, k)) { if (source[k] === '\n') line++; value += source[k]; k++; }
        out.push({ value, line: start }); i = k + quotes; continue;
      }
      let k = j + 1, value = '', depth = 0;
      while (k < n) {
        const d = source[k];
        if (interpolated && depth === 0 && d === '{' && source[k + 1] === '{') { value += '{'; k += 2; continue; }
        if (interpolated && d === '{' && depth === 0) { depth = 1; value += '{'; k++; continue; }
        if (interpolated && depth > 0) {
          if (d === '{') depth++;
          else if (d === '}') depth--;
          else if (d === '"') { k++; while (k < n && source[k] !== '"') { if (source[k] === '\\') k++; k++; } k++; continue; }
          value += d; k++; continue;
        }
        if (verbatim) { if (d === '"') { if (source[k + 1] === '"') { value += '"'; k += 2; continue; } break; } }
        else { if (d === '\\') { value += source[k + 1]; k += 2; continue; } if (d === '"') break; }
        if (d === '\n') line++;
        value += d; k++;
      }
      out.push({ value, line: start }); i = k + 1; continue;
    }
    i = j === i ? i + 1 : j;
  }
  return out;
}

// Self-check: the guard finds German and leaves English alone.
assert.ok(germanLines('throw new Error("Die Datenbank wurde nicht gefunden.");').length === 1, 'a German sentence is found');
assert.ok(germanLines('Sicherung vor Migration angelegt: x').length === 1, 'an umlaut-free German sentence with a stop word is found');
assert.ok(germanLines("Repariere es mit „node x“").length === 1, 'German quotation marks are found');
assert.deepEqual(germanLines('throw new Error("The database was not found. Run migrate first.");'), [], 'English passes');
assert.deepEqual(csharpLiterals('var a = "Ungültige Eingabe."; // "Kommentar"\nchar q = \'"\'; var b = $"Wert {x + "y"} ok"; var c = @"C:\\Pfad ""zitiert""";').map(item => item.value),
  ['Ungültige Eingabe.', 'Wert {x + } ok', 'C:\\Pfad "zitiert"'], 'C# literals without comments and character literals');

const failures = [];
for (const file of operatorFiles) {
  let text = fs.readFileSync(file, 'utf8');
  if (file === 'scripts/selfhost.mjs') {
    assert.equal(text.split(ownerDescription).length, 2, 'the Owner role description appears exactly once');
    text = text.replace(ownerDescription, "''");
  }
  failures.push(...germanLines(text).map(line => `${file}:${line}`));
}

const agentDirectory = 'agent/v3';
const agentSources = fs.readdirSync(agentDirectory).filter(name => name.endsWith('.cs') && !/Tests\.cs$/.test(name)).sort();
assert.ok(agentSources.includes('AgentMessages.cs') && agentSources.includes('NativeManagement.cs') && !agentSources.includes('SelfTests.cs'), 'the agent sources without the test files');
for (const name of agentSources) {
  for (const { value, line } of csharpLiterals(fs.readFileSync(path.join(agentDirectory, name), 'utf8'))) {
    if (german.test(value)) failures.push(`${agentDirectory}/${name}:${line}: ${value.slice(0, 160)}`);
  }
}
assert.deepEqual(failures, [], 'operator, developer and agent output is English');
console.log(`PASS English operator messages: ${operatorFiles.length} operator files and ${agentSources.length} agent sources without German text.`);
