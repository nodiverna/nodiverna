// The repository and the image hold no agent: no binaries in public/downloads,
// no built-in release records in lib/, no per-origin signature and no runtime
// signing key. Installations import signed releases (runtime/release-import.mjs).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { serverDeskRoot } from '../support/paths.mjs';

const root = serverDeskRoot;
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };

// The built-in files and the release-config tools are gone.
for (const file of ['lib/builtin-release.json', 'lib/previous-builtin-releases.json', 'deploy/release-config.mjs', 'scripts/release-config.mjs', 'tests/selfhost-release-config.mjs']) check(!fs.existsSync(path.join(root, file)), `${file} is removed`);
// The removed test stays removed in every folder below tests/: the check goes by base name.
const testBaseNames = fs.readdirSync(path.join(root, 'tests'), { recursive: true }).map(file => path.basename(String(file)));
check(testBaseNames.length > 350 && !testBaseNames.includes('selfhost-release-config.mjs'), 'selfhost-release-config.mjs is in no folder below tests/');
try {
  const tracked = execFileSync('git', ['ls-files', 'public/downloads'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  check(tracked === '', `no file below public/downloads is tracked: ${tracked}`);
} catch { console.log('SKIP git ls-files: no Git working tree'); }
check(read('.gitignore').split(/\r?\n/).includes('/public/downloads/'), '.gitignore keeps public/downloads/ out of the repository');
check(read('.dockerignore').split(/\r?\n/).includes('public/downloads'), '.dockerignore keeps public/downloads out of the image');

// The Dockerfile copies only the publisher pin from lib/ and nothing from deploy/.
const dockerfile = read('Dockerfile');
const copies = dockerfile.split(/\r?\n/).filter(line => /^COPY\b/.test(line));
const fromLib = copies.filter(line => line.includes('/app/lib'));
check(fromLib.length === 1 && /COPY --from=build --chown=node:node \/app\/lib\/release-publisher\.json \.\/lib\/$/.test(fromLib[0]), `only lib/release-publisher.json: ${fromLib.join(' | ')}`);
check(!copies.some(line => line.includes('/app/deploy')), 'no file of deploy/ in the image');

// No code, script or image line reads the removed paths.
const walk = directory => !fs.existsSync(directory) ? [] : fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const absolute = path.join(directory, entry.name);
  if (entry.isDirectory()) return ['node_modules', '.next'].includes(entry.name) ? [] : walk(absolute);
  return /\.(?:[cm]?[jt]sx?|json|ya?ml|sh|ps1)$/.test(entry.name) ? [absolute] : [];
});
const code = [...['app', 'lib', 'runtime', 'scripts', 'deploy', 'ui', 'agent'].flatMap(directory => walk(path.join(root, directory))), path.join(root, 'instrumentation.ts'), path.join(root, 'Dockerfile'), path.join(root, 'package.json')];
const relative = file => path.relative(root, file).split(path.sep).join('/');
const retiredPaths = /builtin-release\.json|previous-builtin-releases\.json|public\/downloads|release-config\.mjs/;
check(code.filter(file => retiredPaths.test(fs.readFileSync(file, 'utf8'))).map(relative).length === 0, `no source names a removed path: ${code.filter(file => retiredPaths.test(fs.readFileSync(file, 'utf8'))).map(relative).join(', ')}`);

// The retired variables are read nowhere and are not configured; the docs name them once.
const retiredNames = /BUILTIN_RELEASE_SIGNATURE|RELEASE_SIGNING_KEY/;
const configured = [...code, ...['.env.example', 'deploy/runtime.env.example', 'compose.yaml', 'compose.dev.yaml'].map(file => path.join(root, file)).filter(file => fs.existsSync(file))];
check(configured.filter(file => retiredNames.test(fs.readFileSync(file, 'utf8'))).length === 0, `no source or example names a retired variable: ${configured.filter(file => retiredNames.test(fs.readFileSync(file, 'utf8'))).map(relative).join(', ')}`);
const docs = fs.readdirSync(path.join(root, 'docs')).filter(name => name.endsWith('.md'));
const mentions = docs.flatMap(name => read(`docs/${name}`).split(/\r?\n/).filter(line => retiredNames.test(line)).map(line => [name, line]));
check(mentions.length === 1 && mentions[0][0] === 'self-hosting.md', `the docs name the retired variables in one place only: ${JSON.stringify(mentions)}`);
check(/no longer used/i.test(mentions[0]?.[1] ?? ''), 'and say that they are no longer used');

// The runtime has no asset binding and no materialized built-in manifest.
check(!/createAssets|ASSETS/.test(read('runtime/env.mjs')), 'runtime/env.mjs has no asset binding');
check(!/materializeBuiltinManifest/.test(read('runtime/release-manifest.mjs')), 'the materializer is removed');
check(!/release-config/.test(read('scripts/pipeline.mjs')), 'pipeline.mjs has no release-config command');
check(!/--release-config|BUILTIN_RELEASE_SIGNATURE/.test(read('deploy/azure.mjs')), 'deploy/azure.mjs sets no release signature');
console.log(`PASS no agent binaries (${checks} assertions): no built-in records, binaries, release-config or signing variables in the repository and the image.`);
