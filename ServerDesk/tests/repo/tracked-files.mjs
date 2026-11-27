// Every tracked file has a user (job 338, the public file audit). Four rules on the files below
// ServerDesk/: public/ holds exactly the listed static files (the ignored public/downloads/ does not
// count); drizzle/meta/ holds exactly _journal.json and the snapshot of the last journal entry,
// because drizzle-kit reads only the newest snapshot; every docs/*.md is named by file name in a
// README, in the help panel or in another document; every tests/support/*.mjs is named by file name
// in another .mjs file below tests/ or scripts/. Each rule also runs against a small in-memory tree
// that breaks it, so the test proves that the rule can fail. It needs no Git and no database.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {serverDeskRoot} from '../support/paths.mjs';

const root = serverDeskRoot;
let checks = 0;
const none = (violations, label) => { assert.deepEqual(violations, [], label); checks++; };
const fails = (violations, label) => { assert.ok(violations.length > 0, `the rule fails for a broken tree: ${label}`); checks++; };

// ---- The tree: files as posix paths relative to ServerDesk/ ("/README.md" is the repository
// README), and a reader.
const walkedFolders = ['public', 'drizzle/meta', 'docs', 'tests', 'scripts'];
const skipped = new Set(['node_modules', 'public/downloads']);
const singleFiles = ['/README.md', 'README.md', 'agent/v3/README.md', 'ui/shell/help-panel.tsx'];
const onDisk = file => file.startsWith('/') ? path.join(root, '..', file.slice(1)) : path.join(root, file);
function diskTree() {
  const files = [];
  const walk = relative => {
    for (const entry of fs.readdirSync(path.join(root, relative), {withFileTypes: true})) {
      const child = `${relative}/${entry.name}`;
      if (skipped.has(child) || skipped.has(entry.name)) continue;
      if (entry.isDirectory()) walk(child); else files.push(child);
    }
  };
  for (const folder of walkedFolders) if (fs.existsSync(path.join(root, folder))) walk(folder);
  for (const file of singleFiles) if (fs.existsSync(onDisk(file))) files.push(file);
  return {files, read: file => fs.readFileSync(onDisk(file), 'utf8')};
}
/** An in-memory tree from {path: text}. */
const memoryTree = entries => ({files: Object.keys(entries), read: file => entries[file]});

const inFolder = (tree, folder) => tree.files.filter(file => path.posix.dirname(file) === folder);
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** True if the text names the file by its base name, not as the end of a longer name (automation.md in v3-automation.md). */
const names = (text, file) => new RegExp(`(?<![\\w.-])${escape(path.posix.basename(file))}(?![\\w-])`).test(text);

// ---- Rule 1: public/ holds exactly these static files. A new static file needs an entry here.
const publicFiles = [
  'Bootstrap-ServerDesk-V3.ps1', 'Uninstall-ServerDesk.ps1', 'favicon.svg',
  ...['bloom', 'dune', 'dusk', 'mist', 'slate', 'tide'].map(name => `backgrounds/${name}.svg`),
].map(file => `public/${file}`).sort();
function publicRule(tree) {
  const present = tree.files.filter(file => file.startsWith('public/') && !file.startsWith('public/downloads/'));
  return [
    ...present.filter(file => !publicFiles.includes(file)).map(file => `${file} is no listed static file: delete it, or add it to publicFiles in tests/repo/tracked-files.mjs`),
    ...publicFiles.filter(file => !present.includes(file)).map(file => `${file} is missing`),
  ];
}

// ---- Rule 2: drizzle/meta/ holds exactly _journal.json and the snapshot of the last journal entry.
function snapshotRule(tree) {
  const present = inFolder(tree, 'drizzle/meta');
  if (!present.includes('drizzle/meta/_journal.json')) return ['drizzle/meta/_journal.json is missing'];
  const last = JSON.parse(tree.read('drizzle/meta/_journal.json')).entries.at(-1);
  if (!last) return ['drizzle/meta/_journal.json has no entry'];
  const newest = `drizzle/meta/${String(last.idx).padStart(4, '0')}_snapshot.json`;
  const extra = present.filter(file => file !== 'drizzle/meta/_journal.json' && file !== newest);
  return [
    ...(extra.length ? [`delete ${extra.join(', ')}: Git tracks only drizzle/meta/_journal.json and the snapshot of the newest migration, ${newest} (CONTRIBUTING.md, schema steps)`] : []),
    ...(present.includes(newest) ? [] : [`${newest}, the snapshot of the last journal entry ${last.tag}, is missing`]),
  ];
}

// ---- Rule 3: every docs/*.md is named in a README, in the help panel or in another document.
const docReaders = ['/README.md', 'README.md', 'agent/v3/README.md', 'ui/shell/help-panel.tsx'];
function docsRule(tree) {
  const documents = inFolder(tree, 'docs').filter(file => file.endsWith('.md'));
  const texts = [...docReaders.filter(file => tree.files.includes(file)), ...documents].map(file => [file, tree.read(file)]);
  return documents
    .filter(document => !texts.some(([file, text]) => file !== document && names(text, document)))
    .map(document => `${document} is linked nowhere: name it in a README, ui/shell/help-panel.tsx or another docs/*.md`);
}

// ---- Rule 4: every tests/support/*.mjs is named in another .mjs file below tests/ or scripts/.
function supportRule(tree) {
  const helpers = inFolder(tree, 'tests/support').filter(file => file.endsWith('.mjs'));
  const texts = tree.files.filter(file => /^(?:tests|scripts)\//.test(file) && file.endsWith('.mjs')).map(file => [file, tree.read(file)]);
  return helpers
    .filter(helper => !texts.some(([file, text]) => file !== helper && names(text, helper)))
    .map(helper => `${helper} has no user: no other .mjs file below tests/ or scripts/ names it`);
}

// ---- The real tree.
const disk = diskTree();
none(publicRule(disk), 'public/ holds exactly the listed static files');
none(snapshotRule(disk), 'drizzle/meta/ holds exactly _journal.json and the newest snapshot');
none(docsRule(disk), 'every document is linked');
none(supportRule(disk), 'every test helper has a user');

// ---- Small in-memory trees: a valid one passes, each broken one fails.
const journal = JSON.stringify({entries: [{idx: 0, tag: '0000_first'}, {idx: 1, tag: '0001_second'}]});
const valid = {
  ...Object.fromEntries(publicFiles.map(file => [file, ''])),
  'public/downloads/agent.zip': '',
  'drizzle/meta/_journal.json': journal,
  'drizzle/meta/0001_snapshot.json': '{}',
  '/README.md': 'See [the guide](ServerDesk/docs/guide.md).',
  'docs/guide.md': 'Details are in [`v3-guide.md`](v3-guide.md).',
  'docs/v3-guide.md': 'The contract.',
  'tests/support/helper.mjs': "export const value = 1;",
  'tests/api/user.mjs': "import {value} from '../support/helper.mjs';",
  'scripts/run.mjs': "import '../tests/support/other-helper.mjs';",
  'tests/support/other-helper.mjs': '',
};
const tree = memoryTree(valid);
none(publicRule(tree), 'the in-memory tree passes publicRule');
none(snapshotRule(tree), 'the in-memory tree passes snapshotRule');
none(docsRule(tree), 'the in-memory tree passes docsRule');
none(supportRule(tree), 'the in-memory tree passes supportRule');

const broken = (changes) => { const entries = {...valid, ...changes}; for (const [file, text] of Object.entries(changes)) if (text === null) delete entries[file]; return memoryTree(entries); };
fails(publicRule(broken({'public/Agent-Setup.txt': 'old'})), 'an extra file in public/');
fails(publicRule(broken({'public/favicon.svg': null})), 'a listed file is missing in public/');
fails(publicRule(broken({'public/backgrounds/new.svg': ''})), 'an extra background');
fails(snapshotRule(broken({'drizzle/meta/0000_snapshot.json': '{}'})), 'a second snapshot');
fails(snapshotRule(broken({'drizzle/meta/0001_snapshot.json': null})), 'the newest snapshot is missing');
fails(snapshotRule(broken({'drizzle/meta/0001_snapshot.json': null, 'drizzle/meta/0000_snapshot.json': '{}'})), 'only an older snapshot');
assert.match(snapshotRule(broken({'drizzle/meta/0000_snapshot.json': '{}'}))[0], /^delete drizzle\/meta\/0000_snapshot\.json: .*0001_snapshot\.json/, 'the failure names the file to delete and the snapshot to keep'); checks++;
fails(docsRule(broken({'docs/orphan.md': 'Nobody links me.'})), 'a document without a link');
fails(docsRule(broken({'docs/guide.md': 'See guide.md for more.', '/README.md': ''})), 'a document that names only itself');
fails(docsRule(broken({'docs/guide.md': 'No link.', 'docs/v3-guide.md': 'Read v3-guide.md.', '/README.md': 'See v3-guide.md.'})), 'a longer name does not count for guide.md');
fails(supportRule(broken({'tests/support/unused.mjs': 'export const x = 1;'})), 'a support file without a user');
fails(supportRule(broken({'tests/support/self.mjs': "// self.mjs names only itself"})), 'a support file that names only itself');
fails(supportRule(broken({'tests/api/user.mjs': "import {value} from '../support/big-helper.mjs';", 'tests/support/big-helper.mjs': ''})), 'a longer name does not count for helper.mjs');

console.log(`${checks} tracked file checks passed.`);
