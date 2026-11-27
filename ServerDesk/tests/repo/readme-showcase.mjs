// The root README as a short product showcase: the centered header, the line
// limit, the intro, the section order, the Features list, the four screenshots
// and their size, the four-step Quick start on deploy/quickstart/compose.yaml,
// the Documentation links, the CONTRIBUTING link to the source setup, and the
// Playwright project that makes the screenshots.
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
const workflow = 'https://github.com/nodiverna/nodiverna/actions/workflows/docker-image.yml';
const expectedHeader = [
  '<p align="center">',
  '<img src="ServerDesk/public/favicon.svg" width="96" height="96" alt="Nodiverna logo">',
  '</p>',
  '<h1 align="center">Nodiverna</h1>',
  '<p align="center">Self-hosted management portal for your servers and PCs.</p>',
  '<p align="center">',
  `<a href="${workflow}"><img src="${workflow}/badge.svg" alt="Docker image"></a>`,
  '<a href="https://github.com/nodiverna/nodiverna/pkgs/container/nodiverna"><img src="https://img.shields.io/github/v/release/nodiverna/nodiverna?filter=v*&sort=semver&label=image" alt="Image version"></a>',
  '<a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue" alt="License: AGPL-3.0"></a>',
  '</p>',
  '<p align="center">',
  '<a href="#quick-start">Quick start</a> · <a href="#features">Features</a> · <a href="#screenshots">Screenshots</a> · <a href="#documentation">Documentation</a> · <a href="#license">License</a>',
  '</p>',
];
const nonEmpty = lines.map((line) => line.trim()).filter(Boolean);
assert.deepEqual(nonEmpty.slice(0, expectedHeader.length), expectedHeader, 'README.md starts with the header block');
checks++;
const lineCount = readme.trimEnd().split('\n').length;
check(lineCount <= 110, `README.md has at most 110 lines, got ${lineCount}`);

// The level-2 sections, in order, and the header links to their slugs.
const sections = lines.filter((line) => line.startsWith('## ')).map((line) => line.slice(3));
assert.deepEqual(sections, ['Features', 'Screenshots', 'Quick start', 'Documentation', 'Contributing and security', 'License']);
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
// Sentences of prose: a full stop, question or exclamation mark before a new sentence.
const sentences = (text) => text.trim().split(/(?<=[.!?])\s+(?=[A-Z`*[])/).filter((sentence) => sentence.trim());

// The intro after the hero: at most four sentences on what Nodiverna is.
const intro = readme.slice(readme.indexOf('</picture>') + '</picture>'.length, readme.indexOf('\n## ')).trim();
check(sentences(intro).length <= 4, `the intro has at most four sentences, got ${sentences(intro).length}`);
for (const needle of ['self-hosted', 'servers and PCs', 'outgoing HTTPS', 'one Docker image']) check(intro.includes(needle), `the intro names ${needle}`);

// Features: at most seven one-line bullets of at most 25 words, one with the agent platforms; no OS table.
const features = section('Features').split('\n').filter((line) => line.trim());
check(features.every((line) => line.startsWith('- ')), 'Features is only a list of one-line bullets');
check(features.length <= 7, `Features has at most seven bullets, got ${features.length}`);
for (const bullet of features) {
  const words = bullet.slice(2).split(/\s+/).filter(Boolean).length;
  check(words <= 25, `the bullet has at most 25 words, got ${words}: ${bullet}`);
  check(!bullet.includes('**'), `the bullet has no bold run-in: ${bullet}`);
}
const platforms = features.find((bullet) => bullet.includes('Windows Server'));
for (const name of ['Windows Server 2022 and 2025', 'Windows 11 Pro and Enterprise (x64)', 'Ubuntu and Debian are planned'])
  check(platforms?.includes(name), `a Features bullet names ${name}`);
check(!/^\|.*\|$/m.test(readme), 'README.md has no table');

// Local images exist and have English alt texts, the hero has a dark variant,
// and every screenshot is a PNG of 1440×900, at most 1 MB.
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
  check(size === '1440x900', `${image} is 1440×900, got ${size}`);
  sizes.add(size);
  check(bytes.length <= 1_048_576, `${image} has at most 1 MB, got ${bytes.length} bytes`);
}
check(sizes.size === 1, `all screenshots have the same size: ${[...sizes].join(', ')}`);
const expectedImages = ['readme-dashboard.png', 'readme-device.png', 'readme-fleet-dark.png', 'readme-fleet-light.png'];
assert.deepEqual(screenshots.map((image) => path.posix.basename(image)).sort(), expectedImages, 'the README uses exactly the four README images');
checks++;
const imageFolder = fs.readdirSync(path.join(root, 'docs', 'images')).filter((name) => /^readme-.*\.png$/.test(name)).sort();
assert.deepEqual(imageFolder, expectedImages, 'docs/images holds only the README images that README.md uses');
checks++;
check(!fs.existsSync(path.join(root, 'docs', 'images', 'readme-services.png')), 'readme-services.png is gone');
const screenshotSection = section('Screenshots');
for (const file of ['readme-dashboard.png', 'readme-device.png'])
  check(screenshotSection.includes(`<img src="ServerDesk/docs/images/${file}" alt="`), `Screenshots shows ${file}`);
check(screenshotSection.split('\n').filter((line) => /^\*[^*].*[^*]\*$/.test(line.trim())).length === 2, 'each screenshot has an italic one-line caption');
check(screenshotSection.includes('fictional'), 'Screenshots says that the samples are fictional');

// The Quick start: one requirements sentence and four numbered steps with one
// command block each, on the quick-start Compose file.
const quickStart = section('Quick start');
const quickLines = quickStart.split('\n');
const steps = quickLines.filter((line) => /^\d+\. /.test(line));
assert.deepEqual(steps.map((line) => line.split('.')[0]), ['1', '2', '3', '4'], 'the Quick start has four numbered steps');
checks++;
const blocks = [...quickStart.matchAll(/^[ \t]*```[^\n]*\n([\s\S]*?)^[ \t]*```[ \t]*$/gm)].map((match) => match[1].split('\n').map((line) => line.trim()).filter(Boolean));
const rawUrl = 'https://raw.githubusercontent.com/nodiverna/nodiverna/main/ServerDesk/deploy/quickstart/compose.yaml';
assert.deepEqual(blocks, [
  ['mkdir nodiverna && cd nodiverna', `curl -fsSLO ${rawUrl}`],
  ['docker run --rm ghcr.io/nodiverna/nodiverna:latest node scripts/selfhost.mjs secrets > .env', 'chmod 600 .env'],
  ['docker compose up -d'],
  ['docker compose exec app node scripts/selfhost.mjs bootstrap-owner --username admin --display-name Administrator'],
], 'the four Quick start command blocks');
checks++;
// Block n comes after step n and before step n + 1.
const stepAt = steps.map((line) => quickLines.indexOf(line));
const blockAt = quickLines.flatMap((line, index) => /^\s*```\S/.test(line) ? [index] : []);
for (let index = 0; index < 4; index++) check(stepAt[index] < blockAt[index] && (index === 3 || blockAt[index] < stepAt[index + 1]), `step ${index + 1} has its own command block`);
const rawPath = new URL(rawUrl).pathname.split('/').slice(4).join('/');
check(rawPath === 'ServerDesk/deploy/quickstart/compose.yaml', `step 1 downloads the quick-start file, got ${rawPath}`);
check(fs.existsSync(path.join(repo, rawPath)), `the downloaded file ${rawPath} exists in the repository`);
check(/^ {2}app:$/m.test(read(rawPath)), 'docker compose exec app names a service of the quick-start file');
const requirements = quickLines.slice(0, stepAt[0]).join(' ').trim();
check(sentences(requirements).length === 1, 'one sentence of requirements before the steps');
for (const needle of ['Docker', '2.23.1', '`linux/amd64`', 'checkout', 'build', 'Node.js']) check(requirements.includes(needle), `the requirements name ${needle}`);
const prose = quickLines.filter((line) => !/^\s*```/.test(line)).join('\n');
for (const needle of ['only one time', 'first password', 'PORTAL_HOST=<address>', 'PORTAL_HOST=192.168.1.10', 'https://localhost:8443', 'https://<PORTAL_HOST>:8443',
  'certificate', '24 hours', 'password and MFA', '`docker compose pull`', '`docker compose up -d`', 'automatically', '(ServerDesk/docs/self-hosting.md#run-with-docker-compose)'])
  check(prose.includes(needle), `the Quick start text names ${needle}`);
for (const forbidden of ['--env-file', '.env.runtime', 'node -e', 'runtime.env.example', 'grep', 'REPLACE_WITH'])
  check(!quickStart.includes(forbidden), `the Quick start has no ${forbidden}`);

// Documentation: one-line links to the guides, the agent, security, the source setup and the releases.
const documentation = section('Documentation').split('\n').filter((line) => line.trim());
check(documentation.every((line) => /^- \[[^\]]+\]\([^)]+\)/.test(line)), 'Documentation is a list of one-line links');
for (const target of ['ServerDesk/docs/self-hosting.md', 'ServerDesk/agent/v3/README.md', 'SECURITY.md', 'ServerDesk/docs/self-hosting.md#develop-and-test-locally', 'https://github.com/nodiverna/nodiverna/releases'])
  check(documentation.some((line) => line.includes(`](${target})`)), `Documentation links ${target}`);
check(documentation.some((line) => line.includes('(ServerDesk/agent/v3/README.md)') && line.includes('**Add device**')), 'the agent link names the registration with Add device');

// The removed sections and strings, and the short closing sections.
for (const old of ['## Run from source', '## Register a Windows device', '## Supported operating systems', 'pipeline.mjs', 'pnpm', '#run-from-source'])
  check(!readme.includes(old), `README.md no longer contains "${old}"`);
const contributing = section('Contributing and security');
check(sentences(contributing).length <= 3, `Contributing and security has at most three sentences, got ${sentences(contributing).length}`);
check(contributing.includes('(CONTRIBUTING.md)') && contributing.includes('(SECURITY.md)'), 'Contributing and security links CONTRIBUTING.md and SECURITY.md');
check(section('License').split(/\n\s*\n/).filter((paragraph) => paragraph.trim()).length <= 3, 'License has at most three paragraphs');

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
check(readmeProject.scale === 1, `the readme project has a device scale factor of 1, got ${readmeProject.scale}`);
checks += 4;
const spec = read('ServerDesk/e2e/readme.spec.ts');
check(spec.includes('serverdesk-locale') && spec.includes('serverdesk-theme'), 'the spec sets the locale and theme cookies');
check(spec.includes("{name: 'serverdesk-locale', value: 'en'"), 'the spec sets the English locale');
check(spec.includes("'../docs/images/'"), 'the spec writes to docs/images');
for (const file of ['readme-fleet-${theme}.png', 'readme-dashboard.png', 'readme-device.png']) check(spec.includes(file), `the spec writes ${file}`);
check(!spec.includes('readme-services.png'), 'the spec no longer writes readme-services.png');
check(spec.includes("location.hash = '#dashboard'"), 'the spec opens the Dashboard');
check(/preferences\(page, baseURL, 'dark'\);\s*await sampleFleet\(page\);\s*await page\.locator\('\.sdx-fleet \.sdx-device-cell', \{hasText: 'SRV-APP01'\}\)\.click\(\);\s*await expect\(page\)\.toHaveURL\(\/#device\\\/demo-app\$\/\)/.test(spec), 'the spec opens the overview of SRV-APP01 in dark mode');
check(spec.includes("from './support/fixtures'"), 'the spec uses the page-error fixture');

// The README links no maintainer documents and no factory tooling.
for (const internal of ['docs/e2e.md', 'docs/releasing.md', 'factory' + '/']) check(!readme.includes(internal), `README.md does not mention ${internal}`);

// No old German sections, and the inbound link of CONTRIBUTING.md uses the source setup in docs/self-hosting.md.
for (const old of ['ServerDesk ist', '## Lizenz', '## Lokal starten']) check(!readme.includes(old), `README.md no longer contains "${old}"`);
const contributingFile = read('CONTRIBUTING.md');
check(contributingFile.includes('(ServerDesk/docs/self-hosting.md#develop-and-test-locally)'), 'CONTRIBUTING.md links the source setup in docs/self-hosting.md');
check(!contributingFile.includes('README.md#run-from-source'), 'CONTRIBUTING.md no longer links README.md#run-from-source');

console.log(`${checks} README showcase checks passed.`);
