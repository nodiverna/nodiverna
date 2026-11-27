// One home for the repository and the image: the public repo nodiverna/nodiverna and
// ghcr.io/nodiverna/nodiverna. The scan reads every file of `git ls-files`:
// - the former repository and image name occurs only in the subsection
//   "### Change to the new image name" of ServerDesk/docs/self-hosting.md (and at
//   least once there);
// - the former owner name occurs elsewhere only as the CODEOWNERS line and in the
//   ci-workflow.mjs assertion that pins that line.
// It also checks the position and the content of that subsection, and that the
// image checks of deploy/azure.mjs and scripts/pipeline.mjs still accept a GHCR and
// a Docker Hub reference. The needles are built from parts, so this file does not
// match itself. A self-test with injected lines fails the scan.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { repositoryRoot, serverDeskRoot } from '../support/paths.mjs';

const owner = ['lostin', 'dreamz'].join('');
const formerHome = `${owner}/nodiverna`;
const codeOwnersLine = `* @${'LostIn'}${'DreamZ'}`;
const selfHostingFile = 'ServerDesk/docs/self-hosting.md';
const migrationHeading = '### Change to the new image name';

/** The 0-based line numbers of the migration subsection in self-hosting.md: from its heading to the next heading of level 1 to 3. */
export function migrationLines(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.indexOf(migrationHeading);
  if (start < 0) return new Set();
  let fenced = false;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    if (/^\s*```/.test(lines[index])) fenced = !fenced;
    if (!fenced && /^#{1,3} /.test(lines[index])) { end = index; break; }
  }
  return new Set(Array.from({ length: end - start }, (_, offset) => start + offset));
}

/** The lines of `file` that name the former home or owner outside the allowed places, as "file:line". */
export function findings(file, text) {
  const allowed = file === selfHostingFile ? migrationLines(text) : new Set();
  const found = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const lower = line.toLowerCase();
    if (!lower.includes(owner)) return;
    if (allowed.has(index)) return;
    if (file === '.github/CODEOWNERS' && line === codeOwnersLine) return;
    // The existing CODEOWNERS test pins the line verbatim.
    if (file === 'ServerDesk/tests/repo/ci-workflow.mjs' && !lower.includes(formerHome) && line.includes(`['${codeOwnersLine}']`)) return;
    found.push(`${file}:${index + 1}`);
  });
  return found;
}

const selfHosting = readFileSync(path.join(repositoryRoot, selfHostingFile), 'utf8');

test('self-test: an injected former name fails the scan, the allowed places pass', () => {
  assert.deepEqual(findings('README.md', `docker pull docker.io/${formerHome}:latest`), ['README.md:1']);
  assert.deepEqual(findings('README.md', `See https://github.com/${owner.toUpperCase()}/x`), ['README.md:1'], 'any case counts');
  assert.deepEqual(findings('ServerDesk/lib/x.ts', 'const a = 1;'), []);
  assert.deepEqual(findings('.github/CODEOWNERS', `# Owners\n${codeOwnersLine}`), []);
  assert.deepEqual(findings('.github/CODEOWNERS', `${codeOwnersLine} @other`), ['.github/CODEOWNERS:1'], 'only the exact CODEOWNERS line');
  assert.deepEqual(findings('ServerDesk/tests/repo/ci-workflow.mjs', `x = ['${codeOwnersLine}'];\ny = '${formerHome}';`), ['ServerDesk/tests/repo/ci-workflow.mjs:2']);
  const doc = ['## Run', `${formerHome} before`, migrationHeading, `${formerHome} inside`, '```sh', '# a shell comment, no heading', `${formerHome} in code`, '```', '### Next', `${formerHome} after`].join('\n');
  assert.deepEqual(findings(selfHostingFile, doc), [`${selfHostingFile}:2`, `${selfHostingFile}:10`]);
  assert.equal(findings('ServerDesk/docs/other.md', doc).length, 4, 'the subsection is allowed only in self-hosting.md');
});

test('no tracked file names the former repository, image or owner outside the migration note and CODEOWNERS', () => {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: repositoryRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean).map(name => name.replaceAll('\\', '/'));
  assert.ok(files.length > 500, 'the scan reads the tracked files');
  const hits = files.flatMap(file => {
    let text;
    try { text = readFileSync(path.join(repositoryRoot, file), 'utf8'); } catch { return []; }
    return findings(file, text);
  });
  assert.deepEqual(hits, []);
  const lines = selfHosting.split(/\r?\n/);
  const inside = [...migrationLines(selfHosting)].filter(index => lines[index].toLowerCase().includes(formerHome));
  assert.ok(inside.length >= 1, 'the migration note names the former image');
  const codeOwners = readFileSync(path.join(repositoryRoot, '.github', 'CODEOWNERS'), 'utf8').split(/\r?\n/);
  assert.ok(codeOwners.includes(codeOwnersLine), 'CODEOWNERS keeps the owner line');
});

test('the migration note follows the steps of "Run with Docker Compose" and step 8 links to it', () => {
  const lines = selfHosting.split(/\r?\n/);
  const run = lines.indexOf('## Run with Docker Compose');
  const heading = lines.indexOf(migrationHeading);
  const caddy = lines.indexOf('### HTTPS with the local Caddy CA');
  assert.ok(run >= 0 && run < heading && heading < caddy, 'the subsection is in "Run with Docker Compose", before the Caddy CA');
  // Only the short "Quick-start file" subsection may come between the step list and the note.
  assert.deepEqual(lines.slice(run + 1, heading).filter(line => /^#{1,3} /.test(line)), ['### Quick-start file'], 'no other subsection comes between the step list and the note');
  const section = [...migrationLines(selfHosting)].map(index => lines[index]).join('\n');
  assert.ok(section.includes(`\`docker.io/${formerHome}\` to \`ghcr.io/nodiverna/nodiverna\``), 'it names the old and the new image');
  assert.ok(section.includes(`\`SERVERDESK_IMAGE=docker.io/${formerHome}:<tag>\`, replace it with \`SERVERDESK_IMAGE=ghcr.io/nodiverna/nodiverna:<tag>\``), 'it gives the replacement line');
  assert.ok(section.includes('`.env.deployment`'), 'it names .env.deployment');
  assert.ok(section.includes('curl -fsSLO https://raw.githubusercontent.com/nodiverna/nodiverna/main/ServerDesk/compose.yaml'), 'it downloads the new compose.yaml');
  assert.ok(section.includes('step 8'), 'it points to the update commands of step 8');
  assert.ok(section.includes('The data volumes stay.'), 'it says that the data stays');
  assert.ok(section.includes('`--image ghcr.io/nodiverna/nodiverna:<version>`'), 'it gives the Azure image');
  const step8 = lines.find(line => line.startsWith('8. Update the portal.'));
  assert.ok(step8?.includes('[Change to the new image name](#change-to-the-new-image-name)'), 'step 8 links to the note');
});

test('the image checks of azure.mjs and pipeline.mjs accept the GHCR and the Docker Hub form', () => {
  const imageCheck = '/^[A-Za-z0-9][A-Za-z0-9./:_-]*$/';
  for (const file of ['deploy/azure.mjs', 'scripts/pipeline.mjs']) {
    assert.ok(readFileSync(path.join(serverDeskRoot, file), 'utf8').includes(`if (!${imageCheck}.test(image)) throw new Error('Invalid image reference.');`), file);
  }
  const pattern = /^[A-Za-z0-9][A-Za-z0-9./:_-]*$/;
  assert.equal(pattern.source, imageCheck.slice(1, -1));
  for (const image of ['ghcr.io/nodiverna/nodiverna:0.1.1', 'docker.io/example/nodiverna:0.1.1']) assert.ok(pattern.test(image), image);
});
