import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { serverDeskRoot } from '../support/paths.mjs';

// Every versioned text file under ServerDesk/ has LF line endings in the index
// and in this working tree (root .gitattributes: "* text=auto eol=lf"), so
// checksummed migrations and shipped scripts are byte-identical on every
// checkout. Binary files need an explicit binary attribute, and the shipped
// PowerShell scripts keep their UTF-8 BOM.
const root = serverDeskRoot;
const recheckout = 'git rm -r --cached -q . && git reset --hard';
const bomScripts = ['agent/Uninstall-ServerDesk.ps1', 'public/Bootstrap-ServerDesk-V3.ps1', 'public/Uninstall-ServerDesk.ps1'];

let listing;
try {
  listing = execFileSync('git', ['ls-files', '--eol', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
} catch {
  console.log('SKIP line endings: git ls-files nicht verfügbar (kein git oder ServerDesk/ ist kein Git-Arbeitsbaum)');
  process.exit(0);
}

// Each entry reads "i/<index> w/<worktree> attr/<attributes>\t<path>"; the
// attribute field may contain spaces ("text=auto eol=lf").
const entries = listing.split('\0').filter(Boolean).map(record => {
  const tab = record.indexOf('\t');
  const match = /^i\/(\S*)\s+w\/(\S*)\s+attr\/(.*)$/.exec(record.slice(0, tab).trimEnd());
  assert.ok(tab > 0 && match, `unexpected git ls-files --eol entry: ${JSON.stringify(record)}`);
  return { index: match[1], worktree: match[2], attributes: match[3].trim().split(/\s+/).filter(Boolean), path: record.slice(tab + 1) };
});

// Plausibility: the listing really covers the source tree.
assert.ok(entries.length > 100, `git ls-files listed only ${entries.length} files`);
assert.ok(entries.some(entry => /^drizzle\/0000_[^/]+\.sql$/.test(entry.path)), 'drizzle/0000_*.sql is missing from the listing');
assert.ok(entries.some(entry => entry.path === 'public/Bootstrap-ServerDesk-V3.ps1'), 'public/Bootstrap-ServerDesk-V3.ps1 is missing from the listing');

const sample = paths => paths.slice(0, 20).map(name => `  ${name}`).join('\n') + (paths.length > 20 ? `\n  … (${paths.length - 20} weitere)` : '');
const problems = [];
const report = (paths, message) => { if (paths.length) problems.push(`${message} (${paths.length} Dateien):\n${sample(paths)}`); };

const textEntries = entries.filter(entry => entry.index !== '-text');
const binaryEntries = entries.filter(entry => entry.index === '-text');

report(
  entries.filter(entry => entry.index === 'crlf' || entry.index === 'mixed').map(entry => `${entry.path} (i/${entry.index})`),
  'Index-Einträge mit CR. Normalisiere sie mit "git add --renormalize ." und committe',
);

const withCarriageReturn = [];
for (const entry of textEntries) {
  let bytes;
  try { bytes = readFileSync(path.join(root, entry.path)); } catch (error) {
    if (error.code === 'ENOENT') continue; // deleted in this working tree, nothing to check
    throw error;
  }
  if (bytes.includes(0x0d)) withCarriageReturn.push(entry.path);
}
report(
  withCarriageReturn,
  `Textdateien mit CR (0x0D) im Arbeitsbaum. Checke das Repository einmal neu aus: Committe oder sichere vorher deine Änderungen, dann im Repo-Root "${recheckout}"`,
);

report(
  binaryEntries.filter(entry => !entry.attributes.includes('-text')).map(entry => entry.path),
  'Binärdateien ohne ausdrückliches Binär-Attribut. Ergänze ein passendes "binary"-Muster in der Root-.gitattributes',
);

const bom = Buffer.from([0xef, 0xbb, 0xbf]);
report(
  bomScripts.filter(name => {
    try { return !readFileSync(path.join(root, name)).subarray(0, 3).equals(bom); } catch { return true; }
  }),
  'PowerShell-Skripte ohne UTF-8-BOM (EF BB BF) am Anfang',
);

assert.equal(problems.length, 0, `\n${problems.join('\n\n')}`);
console.log(`PASS line endings: ${textEntries.length} Textdateien ohne CR, ${binaryEntries.length} Binärdateien mit Binär-Attribut, ${bomScripts.length} Skripte mit BOM`);
