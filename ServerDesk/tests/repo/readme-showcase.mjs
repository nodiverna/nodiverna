// The root README as a product showcase: the centered header, the
// section order, the images and their size, the Quick start commands from
// docs/self-hosting.md and the Playwright project that makes the screenshots.
// The writing rules of README.md are in tests/repo/docs-ste100.mjs.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {serverDeskRoot} from '../support/paths.mjs';

const root = serverDeskRoot;
const repo = path.join(root, '..');
const read = (relative) => fs.readFileSync(path.join(repo, relative), 'utf8').replaceAll('\r\n', '\n');
let checks = 0;
const check = (condition, label) => { assert.ok(condition, label); checks++; };

const readme = read('README.md');
const lines = readme.split('\n');
const firstSection = lines.findIndex((line) => line.startsWith('## '));
const header = lines.slice(0, firstSection).join('\n');

// The first non-empty lines are the centered header block.
const workflow = 'https://github.com/LostInDreamZ/nodiverna/actions/workflows/docker-image.yml';
const expectedHeader = [
  '<p align="center">',
  '<img src="ServerDesk/public/favicon.svg" width="96" height="96" alt="Nodiverna logo">',
  '</p>',
  '<h1 align="center">Nodiverna</h1>',
  '<p align="center">Self-hosted management portal for your servers and PCs.</p>',
  '<p align="center">',
  `<a href="${workflow}"><img src="${workflow}/badge.svg" alt="Docker image"></a>`,
  '<a href="https://hub.docker.com/r/lostindreamz/nodiverna"><img src="https://img.shields.io/docker/v/lostindreamz/nodiverna?sort=semver&label=Docker%20Hub" alt="Docker Hub version"></a>',
  '<a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue" alt="License: AGPL-3.0"></a>',
  '</p>',
  '<p align="center">',
  '<a href="#quick-start">Quick start</a> · <a href="#features">Features</a> · <a href="#supported-operating-systems">Supported systems</a> · <a href="#documentation">Documentation</a> · <a href="#license">License</a>',
  '</p>',
];
const nonEmpty = lines.map((line) => line.trim()).filter(Boolean);
assert.deepEqual(nonEmpty.slice(0, expectedHeader.length), expectedHeader, 'README.md starts with the header block');
checks++;

// The level-2 sections, in order, and the header links to their slugs.
const sections = lines.filter((line) => line.startsWith('## ')).map((line) => line.slice(3));
assert.deepEqual(sections, ['Features', 'Supported operating systems', 'Screenshots', 'Quick start', 'Run from source', 'Register a Windows device', 'Documentation', 'Contributing and security', 'License']);
checks++;
const slugs = new Set(sections.map((title) => title.toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replaceAll(' ', '-')));
const headerLinks = [...header.matchAll(/href="#([^"]+)"/g)].map((match) => match[1]);
check(headerLinks.length === 5, 'the header has five section links');
for (const link of headerLinks) check(slugs.has(link), `header link #${link} matches a section`);
const section = (title) => {
  const start = lines.indexOf(`## ${title}`);
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n');
};

// Local images exist and have English alt texts, the hero
// has a dark variant, and every screenshot is a PNG of the same size, at most 1 MB.
const local = (target) => !/^https?:/i.test(target);
const images = [];
for (const match of readme.matchAll(/<(img|source)\b[^>]*>/g)) {
  const tag = match[0];
  for (const attribute of tag.matchAll(/\b(src|srcset)="([^"]*)"/g)) if (local(attribute[2])) images.push(attribute[2]);
  if (match[1] === 'img') {
    const alt = /\balt="([^"]*)"/.exec(tag)?.[1] ?? '';
    check(alt.trim() !== '', `${tag} has an alt text`);
    check(!/[äöüÄÖÜß]/.test(alt), `the alt text "${alt}" is English`);
  }
}
for (const match of readme.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) if (local(match[1])) images.push(match[1]);
for (const image of images) check(fs.existsSync(path.join(repo, image)), `${image} exists`);
const picture = /<picture>([\s\S]*?)<\/picture>/.exec(readme)?.[1] ?? '';
check(picture.includes('<source media="(prefers-color-scheme: dark)" srcset="ServerDesk/docs/images/readme-fleet-dark.png">'), 'the hero has a dark source');
check(picture.includes('<img src="ServerDesk/docs/images/readme-fleet-light.png" alt="Nodiverna fleet overview with four sample devices, their status and load">'), 'the hero falls back to the light image');
check(readme.indexOf('<picture>') < readme.indexOf('\n## '), 'the hero comes before the first section');
const screenshots = [...new Set(images.filter((image) => /^ServerDesk\/docs\/images\/readme-[^/]+\.png$/.test(image)))];
check(screenshots.length === 4, `the README uses four screenshots, got ${screenshots.join(', ')}`);
const sizes = new Set();
for (const image of screenshots) {
  const bytes = fs.readFileSync(path.join(repo, image));
  check(bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), `${image} has the PNG signature`);
  check(bytes.toString('latin1', 12, 16) === 'IHDR', `${image} starts with IHDR`);
  const size = `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`;
  check(['2880x1800', '1440x900'].includes(size), `${image} is 2880×1800 or 1440×900, got ${size}`);
  sizes.add(size);
  check(bytes.length <= 1_048_576, `${image} has at most 1 MB, got ${bytes.length} bytes`);
}
check(sizes.size === 1, `all screenshots have the same size: ${[...sizes].join(', ')}`);

// Each command block of the Quick start is copied from docs/self-hosting.md.
const dedent = (text) => text.split('\n').map((line) => line.trim()).join('\n');
const selfHosting = dedent(read('ServerDesk/docs/self-hosting.md'));
const quickStart = section('Quick start');
const blocks = [...quickStart.matchAll(/^[ \t]*```[^\n]*\n([\s\S]*?)^[ \t]*```[ \t]*$/gm)].map((match) => dedent(match[1]).trimEnd());
check(blocks.length === 6, `the Quick start has six command blocks, got ${blocks.length}`);
for (const block of blocks) check(selfHosting.includes(block), `the Quick start block is in docs/self-hosting.md:\n${block}`);
check(quickStart.includes('2.23.1') && quickStart.includes('`linux/amd64`'), 'the Quick start names Compose 2.23.1 and linux/amd64');
for (const name of ['SITE_ORIGIN=https://192.168.1.10:8443', 'CADDY_ADDRESS=https://192.168.1.10', 'CADDY_SERVER_NAME=192.168.1.10'])
  check(quickStart.includes(name), `step 2 sets ${name}`);
check(quickStart.includes('(ServerDesk/docs/self-hosting.md#run-with-docker-compose)'), 'the Quick start links the full guide');

// The readme project exists only with E2E_README=1.
const projects = (extra) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'E2E_README'));
  const script = `const {default: config} = await import(${JSON.stringify(pathToFileURL(path.join(root, 'e2e/playwright.config.ts')).href)});
console.log(JSON.stringify(config.projects.map((project) => ({name: project.name, dependencies: project.dependencies, viewport: project.use?.viewport, scale: project.use?.deviceScaleFactor, testMatch: String(project.testMatch)}))));`;
  const result = spawnSync(process.execPath, ['--import', './tests/support/register.mjs', '--input-type=module', '-e', script], {cwd: root, encoding: 'utf8', env: {...env, ...extra}, timeout: 60_000});
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
};
assert.deepEqual(projects({}).map((project) => project.name), ['setup', 'desktop', 'mobile']);
const withReadme = projects({E2E_README: '1'});
assert.deepEqual(withReadme.map((project) => project.name), ['setup', 'desktop', 'mobile', 'readme']);
const readmeProject = withReadme.at(-1);
assert.deepEqual(readmeProject.viewport, {width: 1440, height: 900});
assert.deepEqual(readmeProject.dependencies, ['setup']);
check(readmeProject.testMatch === String(/readme\.spec\.ts$/), `the readme project runs only readme.spec.ts, got ${readmeProject.testMatch}`);
check([1, 2].includes(readmeProject.scale), 'the readme project has a device scale factor of 1 or 2');
check(sizes.has(readmeProject.scale === 2 ? '2880x1800' : '1440x900'), 'the screenshots match the device scale factor');
checks += 4;
const spec = read('ServerDesk/e2e/readme.spec.ts');
check(spec.includes('serverdesk-locale') && spec.includes('serverdesk-theme'), 'the spec sets the locale and theme cookies');
check(spec.includes("'../docs/images/'"), 'the spec writes to docs/images');
for (const file of ['readme-fleet-${theme}.png', 'readme-device.png', 'readme-services.png']) check(spec.includes(file), `the spec writes ${file}`);
check(spec.includes("from './support/fixtures'"), 'the spec uses the page-error fixture');

// The README links no maintainer documents and no factory tooling.
for (const internal of ['docs/e2e.md', 'docs/releasing.md', 'factory' + '/']) check(!readme.includes(internal), `README.md does not mention ${internal}`);

// No old German sections, and the inbound anchors use the new slugs.
for (const old of ['ServerDesk ist', '## Lizenz', '## Lokal starten']) check(!readme.includes(old), `README.md no longer contains "${old}"`);
check(read('CONTRIBUTING.md').includes('(README.md#run-from-source)'), 'CONTRIBUTING.md links README.md#run-from-source');

console.log(`${checks} README showcase checks passed.`);
