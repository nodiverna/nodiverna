// The docs-to-wiki converter scripts/wiki-mirror.mjs: page names and their
// errors, the link rewriting rules (doc pages, anchors, images, raw and blob
// URLs, HTML attributes, reference definitions, code that stays unchanged,
// targets that are missing or outside the repository), the page banner, Home.md
// and _Sidebar.md, the image copy, LF output, deterministic builds, the CLI
// that refuses a non-empty --out, Node built-ins only, and a build of the real
// ServerDesk/docs/. Fixture docs live in temp folders, never as committed .md
// files (tests/repo/docs-ste100.mjs checks every Markdown file of the repo).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { serverDeskRoot } from '../support/paths.mjs';
import { buildWiki, listDocs, rewriteLinks, wikiPageName, wikiPageNames } from '../../scripts/wiki-mirror.mjs';

const scriptFile = path.join(serverDeskRoot, 'scripts', 'wiki-mirror.mjs');
const repoUrl = 'https://github.com/nodiverna/nodiverna';
const banner = file => `> This page is generated from [ServerDesk/docs/${file}](${repoUrl}/blob/main/ServerDesk/docs/${file}). Change the text there. The next synchronization replaces changes that you make in the wiki.`;
const temps = [];
test.after(() => { for (const folder of temps) rmSync(folder, { recursive: true, force: true }); });

function tempFolder() {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'wiki-mirror-'));
  temps.push(folder);
  return folder;
}

// A small repository: { 'ServerDesk/docs/a.md': '...', ... } relative to its root.
function fixture(files) {
  const root = tempFolder();
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(root, ...name.split('/'));
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return { root, docsDir: path.join(root, 'ServerDesk', 'docs') };
}

const baseFiles = {
  'ServerDesk/docs/self-hosting.md': '# Operate it yourself\n\n## Run with Docker Compose\n',
  'ServerDesk/docs/customers.md': '# Customers\n',
  'ServerDesk/docs/images/shot.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]),
  'ServerDesk/docs/images/sub/my shot.png': Buffer.from([1, 2, 3]),
  'ServerDesk/docs/notes/inner.md': '# Inner\n',
  'ServerDesk/lib/x.ts': 'export const x = 1;\n',
  'ServerDesk/lib/my file.ts': 'export const y = 2;\n',
  'ServerDesk/public/logo.svg': '<svg/>',
  'README.md': '# Readme\n',
};

const { docsDir } = fixture(baseFiles);
const rewrite = (markdown, file = 'customers.md') => rewriteLinks(markdown, { file, docsDir, repoUrl, branch: 'main' });

test('wikiPageName takes the file stem with its first character in upper case', () => {
  assert.equal(wikiPageName('self-hosting.md'), 'Self-hosting');
  assert.equal(wikiPageName('v3-health-signals.md'), 'V3-health-signals');
  assert.equal(wikiPageName('A_b.c-d.md'), 'A_b.c-d');
});

test('wikiPageName refuses invalid characters and reserved names, and wikiPageNames refuses collisions', () => {
  assert.throws(() => wikiPageName('my page.md'), /my page\.md.*\[A-Za-z0-9\._-\]/);
  assert.throws(() => wikiPageName('über.md'), /über\.md/);
  assert.throws(() => wikiPageName('home.md'), /home\.md.*Home.*reserves/);
  assert.throws(() => wikiPageName('HOME.md'), /HOME\.md/);
  assert.throws(() => wikiPageName('_sidebar.md'), /_sidebar\.md/);
  assert.throws(() => wikiPageName('_footer.md'), /_footer\.md/);
  assert.throws(() => wikiPageName('_x.md'), /_x\.md/);
  assert.throws(() => wikiPageNames(['Setup.md', 'setup.md']), /Setup\.md and setup\.md.*same wiki page name/);
  assert.deepEqual([...wikiPageNames(['b.md', 'a.md'])], [['a.md', 'A'], ['b.md', 'B']]);
});

test('rewriteLinks: doc links become page names with their anchor', () => {
  assert.equal(rewrite('See [setup](self-hosting.md).'), 'See [setup](Self-hosting).');
  assert.equal(rewrite('See [run](self-hosting.md#run-with-docker-compose).'), 'See [run](Self-hosting#run-with-docker-compose).');
  assert.equal(rewrite('See [customers](./customers.md).'), 'See [customers](Customers).');
  assert.equal(rewrite('See [run](../docs/self-hosting.md#x).'), 'See [run](Self-hosting#x).');
});

test('rewriteLinks: anchors and external URLs stay unchanged', () => {
  const text = 'See [below](#setup), [site](https://example.com/a.md), [mail](mailto:team@example.com) and [ftp](ftp://host/x).';
  assert.equal(rewrite(text), text);
  assert.equal(rewrite('Empty [x]() stays.'), 'Empty [x]() stays.');
});

test('rewriteLinks: files below docs/images go to images/', () => {
  assert.equal(rewrite('![Shot](images/shot.png)'), '![Shot](images/shot.png)');
  assert.equal(rewrite('[Open the picture](./images/shot.png)'), '[Open the picture](images/shot.png)');
  assert.equal(rewrite('![Sub](images/sub/my%20shot.png)'), '![Sub](images/sub/my%20shot.png)');
});

test('rewriteLinks: images elsewhere in the repository go to raw/<branch>', () => {
  assert.equal(rewrite('![Logo](../public/logo.svg)'), `![Logo](${repoUrl}/raw/main/ServerDesk/public/logo.svg)`);
});

test('rewriteLinks: other repository targets go to blob/<branch> with their anchor', () => {
  assert.equal(rewrite('[code](../lib/x.ts#L5)'), `[code](${repoUrl}/blob/main/ServerDesk/lib/x.ts#L5)`);
  assert.equal(rewrite('[folder](../lib/)'), `[folder](${repoUrl}/blob/main/ServerDesk/lib)`);
  assert.equal(rewrite('[readme](/README.md)'), `[readme](${repoUrl}/blob/main/README.md)`);
  assert.equal(rewrite('[inner](notes/inner.md)'), `[inner](${repoUrl}/blob/main/ServerDesk/docs/notes/inner.md)`);
  assert.equal(rewrite('[file](../lib/my%20file.ts)'), `[file](${repoUrl}/blob/main/ServerDesk/lib/my%20file.ts)`);
  assert.equal(rewrite('[file](<../lib/my file.ts>)'), `[file](<${repoUrl}/blob/main/ServerDesk/lib/my%20file.ts>)`);
});

test('rewriteLinks keeps titles and rewrites reference definitions and HTML attributes', () => {
  assert.equal(rewrite('[setup](self-hosting.md "The setup")'), '[setup](Self-hosting "The setup")');
  assert.equal(rewrite('[setup][s]\n\n[s]: self-hosting.md#run "Title"\n'), '[setup][s]\n\n[s]: Self-hosting#run "Title"\n');
  assert.equal(rewrite('![logo][l]\n\n[l]: ../public/logo.svg\n'), `![logo][l]\n\n[l]: ${repoUrl}/raw/main/ServerDesk/public/logo.svg\n`);
  assert.equal(rewrite('[code][c]\n\n[c]: <../lib/x.ts>\n'), `[code][c]\n\n[c]: <${repoUrl}/blob/main/ServerDesk/lib/x.ts>\n`);
  assert.equal(
    rewrite('<p><a href="self-hosting.md#x"><img src="images/shot.png" alt="Shot"></a> <img src=\'../public/logo.svg\'></p>'),
    `<p><a href="Self-hosting#x"><img src="images/shot.png" alt="Shot"></a> <img src='${repoUrl}/raw/main/ServerDesk/public/logo.svg'></p>`,
  );
  assert.equal(
    rewrite('<picture><source srcset="images/shot.png 1x, ../public/logo.svg 2x"><img src=images/shot.png></picture>'),
    `<picture><source srcset="images/shot.png 1x, ${repoUrl}/raw/main/ServerDesk/public/logo.svg 2x"><img src=images/shot.png></picture>`,
  );
  assert.equal(rewrite('<a href="https://example.com">x</a> <a href="#top">top</a>'), '<a href="https://example.com">x</a> <a href="#top">top</a>');
  assert.equal(rewrite('[![Shot](images/shot.png)](self-hosting.md)'), '[![Shot](images/shot.png)](Self-hosting)');
  assert.equal(rewrite('A [`code` label](self-hosting.md) link.'), 'A [`code` label](Self-hosting) link.');
});

test('rewriteLinks leaves fenced code, inline code and HTML comments byte for byte', () => {
  const text = [
    'Intro [a](customers.md).',
    '',
    '```md',
    'See [missing](missing.md) and <img src="nothing.png">.',
    '```',
    '',
    '~~~~',
    '[x](../../../../outside.md)',
    '~~~~',
    '',
    'Use `[x](missing.md)` and ``[y](missing.md) with ` inside``.',
    '<!-- [old](missing.md) -->',
    '  ```',
    '  [indented fence](missing.md)',
    '  ```',
    '',
  ].join('\n');
  assert.equal(rewrite(text), text.replace('[a](customers.md)', '[a](Customers)'));
});

test('rewriteLinks refuses missing targets and targets outside the repository, with file and line', () => {
  assert.throws(() => rewrite('Line one.\n\nSee [x](missing.md).', 'customers.md'), /ServerDesk\/docs\/customers\.md:3: .*missing\.md does not exist/);
  assert.throws(() => rewrite('See [x](../../../outside.md).'), /ServerDesk\/docs\/customers\.md:1: .*outside the repository/);
  assert.throws(() => rewrite('[x](/../outside.md)'), /outside the repository/);
  assert.throws(() => rewrite('<img src="images/none.png">'), /:1: .*images\/none\.png does not exist/);
  assert.throws(() => rewrite('[x](Customers.md)'), /does not exist/, 'the case of a file name must match');
});

test('buildWiki writes the pages with banners, Home.md, _Sidebar.md and the images, and nothing else', () => {
  const { docsDir: docs } = fixture({
    ...baseFiles,
    'ServerDesk/docs/zeta.md': '# alpha topic\r\n\r\nSee [b](beta.md).\r\n\r\n\r\n',
    'ServerDesk/docs/beta.md': 'No heading here.',
    'ServerDesk/docs/alpha.md': '# Alpha topic\n',
  });
  const outDir = path.join(tempFolder(), 'out');
  const result = buildWiki({ docsDir: docs, outDir });
  const files = [];
  const walk = (folder, prefix = '') => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(folder, entry.name), `${prefix}${entry.name}/`);
      else files.push(`${prefix}${entry.name}`);
    }
  };
  walk(outDir);
  const expected = ['Alpha.md', 'Beta.md', 'Customers.md', 'Home.md', 'Self-hosting.md', 'Zeta.md', '_Sidebar.md', 'images/shot.png', 'images/sub/my shot.png'];
  assert.deepEqual(files.sort(), expected);
  assert.deepEqual(result.files, expected);
  const read = name => readFileSync(path.join(outDir, name), 'utf8');
  assert.equal(read('Zeta.md'), `${banner('zeta.md')}\n\n# alpha topic\n\nSee [b](Beta).\n`, 'CRLF input gives LF output with one final newline');
  assert.equal(read('Beta.md'), `${banner('beta.md')}\n\nNo heading here.\n`);
  assert.equal(read('Self-hosting.md'), `${banner('self-hosting.md')}\n\n# Operate it yourself\n\n## Run with Docker Compose\n`);
  // Sorted by H1 text without regard to case, then by page name; Beta has no H1 and uses its page name.
  const list = ['- [Alpha topic](Alpha)', '- [alpha topic](Zeta)', '- [Beta](Beta)', '- [Customers](Customers)', '- [Operate it yourself](Self-hosting)'].join('\n');
  assert.equal(read('Home.md'), [
    `> This wiki is generated from the folder [ServerDesk/docs](${repoUrl}/tree/main/ServerDesk/docs). Change the documentation there. The next synchronization replaces changes that you make in the wiki.`,
    '',
    'The documentation of Nodiverna: installation, operation, the areas of the portal and the agent contracts.',
    '',
    '## Pages',
    '',
    list,
    '',
  ].join('\n'));
  assert.equal(read('_Sidebar.md'), `**[Home](Home)**\n\n${list}\n`);
  assert.deepEqual(readFileSync(path.join(outDir, 'images', 'shot.png')), baseFiles['ServerDesk/docs/images/shot.png']);
  assert.deepEqual(readFileSync(path.join(outDir, 'images', 'sub', 'my shot.png')), baseFiles['ServerDesk/docs/images/sub/my shot.png']);
  for (const name of files.filter(file => file.endsWith('.md'))) {
    const text = read(name);
    assert.ok(!text.includes('\r'), `${name} has LF only`);
    assert.ok(text.endsWith('\n') && !text.endsWith('\n\n'), `${name} ends with one newline`);
  }
});

test('buildWiki uses the given repository URL and branch, and stops on a broken link without output', () => {
  const outDir = path.join(tempFolder(), 'out');
  buildWiki({ docsDir, outDir, repoUrl: 'https://example.com/o/r/', branch: 'trunk' });
  assert.match(readFileSync(path.join(outDir, 'Customers.md'), 'utf8'), /^> This page is generated from \[ServerDesk\/docs\/customers\.md\]\(https:\/\/example\.com\/o\/r\/blob\/trunk\/ServerDesk\/docs\/customers\.md\)/);
  const broken = fixture({ ...baseFiles, 'ServerDesk/docs/bad.md': '# Bad\n\n[x](gone.md)\n' });
  const brokenOut = path.join(tempFolder(), 'out');
  assert.throws(() => buildWiki({ docsDir: broken.docsDir, outDir: brokenOut }), /ServerDesk\/docs\/bad\.md:3: .*gone\.md/);
  assert.throws(() => readdirSync(brokenOut), /ENOENT/, 'nothing is written');
  const clash = fixture({ 'ServerDesk/docs/Setup.md': '# A\n', 'ServerDesk/docs/setup.md': '# B\n' });
  // On a file system that ignores case, the second file overwrites the first one.
  if (listDocs(clash.docsDir).length === 2) assert.throws(() => buildWiki({ docsDir: clash.docsDir, outDir: path.join(tempFolder(), 'out') }), /same wiki page name/);
  const reserved = fixture({ 'ServerDesk/docs/home.md': '# Home\n' });
  assert.throws(() => buildWiki({ docsDir: reserved.docsDir, outDir: path.join(tempFolder(), 'out') }), /home\.md/);
});

test('two builds are byte-identical, and a removed doc is absent from the next build', () => {
  const { docsDir: docs } = fixture({ ...baseFiles, 'ServerDesk/docs/old.md': '# Old\n' });
  const snapshot = outDir => Object.fromEntries(readdirSync(outDir, { recursive: true }).map(String).sort().map(name => {
    const full = path.join(outDir, name);
    try { return [name, readFileSync(full).toString('base64')]; } catch { return [name, 'folder']; }
  }));
  const first = path.join(tempFolder(), 'out'), second = path.join(tempFolder(), 'out');
  buildWiki({ docsDir: docs, outDir: first });
  buildWiki({ docsDir: docs, outDir: second });
  assert.deepEqual(snapshot(first), snapshot(second));
  assert.ok('Old.md' in snapshot(first));
  rmSync(path.join(docs, 'old.md'));
  const third = path.join(tempFolder(), 'out');
  buildWiki({ docsDir: docs, outDir: third });
  assert.ok(!('Old.md' in snapshot(third)));
  assert.doesNotMatch(readFileSync(path.join(third, 'Home.md'), 'utf8'), /Old/);
});

test('the CLI refuses an --out folder that exists and is not empty', () => {
  const outDir = tempFolder();
  writeFileSync(path.join(outDir, 'keep.txt'), 'x');
  const run = spawnSync(process.execPath, [scriptFile, '--out', outDir], { encoding: 'utf8' });
  assert.notEqual(run.status, 0);
  assert.ok(run.stderr.includes(outDir), run.stderr);
  assert.match(run.stderr, /exists and is not empty/);
  assert.deepEqual(readdirSync(outDir), ['keep.txt']);
  const missing = spawnSync(process.execPath, [scriptFile], { encoding: 'utf8' });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /--out <dir>/);
});

test('the converter imports only node: built-ins', () => {
  const source = readFileSync(scriptFile, 'utf8');
  const specifiers = [...source.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm), ...source.matchAll(/import\(\s*['"]([^'"]+)['"]/g)].map(match => match[1]);
  assert.ok(specifiers.length > 0);
  for (const specifier of specifiers) assert.match(specifier, /^node:/, specifier);
  assert.doesNotMatch(source, /\brequire\(/);
});

test('the real ServerDesk/docs/ builds: one page per top-level doc, each with its banner, all listed in Home.md', () => {
  const realDocs = path.join(serverDeskRoot, 'docs');
  const outDir = path.join(tempFolder(), 'wiki');
  const run = spawnSync(process.execPath, [scriptFile, '--out', outDir], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const docs = listDocs(realDocs);
  assert.ok(docs.length >= 40, `${docs.length} docs`);
  const pages = docs.map(wikiPageName);
  assert.equal(new Set(pages.map(page => page.toLowerCase())).size, pages.length, 'unique page names');
  const written = readdirSync(outDir).filter(name => name.endsWith('.md')).sort();
  assert.deepEqual(written, [...pages.map(page => `${page}.md`), 'Home.md', '_Sidebar.md'].sort());
  const home = readFileSync(path.join(outDir, 'Home.md'), 'utf8');
  const sidebar = readFileSync(path.join(outDir, '_Sidebar.md'), 'utf8');
  docs.forEach((file, index) => {
    const text = readFileSync(path.join(outDir, `${pages[index]}.md`), 'utf8');
    assert.ok(text.startsWith(`${banner(file)}\n\n# `), `${file} starts with its banner and its H1`);
    assert.ok(home.includes(`](${pages[index]})\n`), `Home.md lists ${pages[index]}`);
    assert.ok(sidebar.includes(`](${pages[index]})\n`), `_Sidebar.md lists ${pages[index]}`);
  });
  assert.equal(home.split('\n').filter(line => line.startsWith('- [')).length, docs.length);
  for (const image of readdirSync(path.join(realDocs, 'images'))) {
    assert.deepEqual(readFileSync(path.join(outDir, 'images', image)), readFileSync(path.join(realDocs, 'images', image)), image);
  }
});
