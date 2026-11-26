import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { appendFileSync, copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { validateReleaseChangelog } from './release-changelog.mjs';
import { pluginNamePattern, pluginReleaseFiles, verifyPluginRelease } from '../runtime/plugin-release-verify.mjs';
import { devVersion, isBaseVersion, isDevVersion, isReleaseVersion } from '../runtime/release-version.mjs';

// Plugin releases from the CI (.github/workflows/plugin-release.yml), next to the
// agent releases of scripts/agent-release.mjs. The plan reads <Version> from the
// project file of the plugin and stops when the tag plugin-<name>-vX.Y.Z exists.
// A run on dev plans the pre-release plugin-<name>-vX.Y.Z-dev.<sha7> with the
// first 7 characters of the commit SHA (runtime/release-version.mjs); it needs
// no changelog file.
// verify checks a record from scripts/sign-plugin-release.mjs against the pinned
// publisher key, and assets collects the GitHub release files. The record has
// the path form (files below /downloads/ without an origin), so the assets are
// valid on every installation. Node built-ins only: the sign and release jobs
// run this script without a package install.

const publicKeyFile = 'agent/v3/release-public.pem';

/** The PascalCase part of the project and EXE name: dhcp gives Dhcp, file-server gives FileServer. */
export const pluginPascalName = name => name.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('');
/** The project file, the changelog folder and the published EXE name of a plugin. */
export function pluginPaths(name) {
  if (typeof name !== 'string' || !pluginNamePattern.test(name)) throw new Error(`The plugin name "${name}" is not valid.`);
  const pascal = pluginPascalName(name);
  return {
    project: `agent/plugins/${name}/ServerDesk.Plugin.${pascal}.csproj`,
    changelogs: `agent/plugins/${name}/changelogs`,
    exe: `ServerDesk.Plugin.${pascal}.exe`,
    publish: `.build/plugin-${name}-publish`,
    artifact: `.build/plugin-${name}-artifact.json`,
    record: `.build/plugin-${name}-release.json`,
  };
}

/** The tag of one plugin version. */
export const pluginTag = (name, version) => `plugin-${name}-v${version}`;

/**
 * Plans one run of the plugin workflow. Pure: the caller reads the files, the
 * commit SHA and the tags. `changelog` is the parsed changelogs/<version>.json,
 * or null when the file is missing; a release from main needs a valid one. A
 * run on dev plans the pre-release X.Y.Z-dev.<sha7> without a changelog; its
 * base X.Y.Z must not be released yet, because a dev build ranks below it.
 * @param {{ csproj: string, ref: string, tags?: string[], name: string, changelog?: unknown, sha?: string }} input
 * @returns {{ name: string, version: string, tag: string, release: boolean, prerelease: boolean }}
 */
export function planPluginRelease({ csproj, ref, tags = [], name, changelog = null, sha }) {
  const { project, changelogs } = pluginPaths(name);
  const base = typeof csproj === 'string' ? /<Version>([^<]*)<\/Version>/.exec(csproj)?.[1] : undefined;
  if (!base) throw new Error(`Plugin version missing in ${project}.`);
  if (!isBaseVersion(base)) throw new Error(`Plugin version "${base}" in ${project} must be X.Y.Z.`);
  if (ref === 'refs/heads/main') {
    const tag = pluginTag(name, base), release = !tags.includes(tag);
    if (release) {
      if (changelog === null || changelog === undefined) throw new Error(`Add ${changelogs}/${base}.json with version, features and fixes before publishing a new plugin release.`);
      validateReleaseChangelog(changelog, base);
    }
    return { name, version: base, tag, release, prerelease: false };
  }
  if (ref !== 'refs/heads/dev') throw new Error(`Plugin releases run only from main or dev (got ${ref}).`);
  const version = devVersion(base, sha), baseTag = pluginTag(name, base), tag = pluginTag(name, version);
  if (tags.includes(baseTag)) throw new Error(`Plugin ${name} ${base} is already released as ${baseTag}. Increase <Version> on dev to build a dev release.`);
  return { name, version, tag, release: !tags.includes(tag), prerelease: true };
}

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

/** The signed record, the exact signed manifest bytes and the signature as release assets. */
export function pluginReleaseAssets(record) {
  const names = pluginReleaseFiles(record.name, record.version);
  return [
    { name: names.record, content: JSON.stringify(record, null, 2) + '\n' },
    { name: names.manifest, content: record.manifest },
    { name: names.signature, content: record.signature },
  ];
}

/** The first line of the notes of a dev pre-release. */
export const pluginDevNotesLine = version => `Dev pre-release ${version} from the dev branch. Portals import it only when an owner turns on dev builds.`;

/** The GitHub release notes from the changelog in the signed manifest; a dev pre-release starts with pluginDevNotesLine. */
export function pluginReleaseNotes(record) {
  const manifest = JSON.parse(record.manifest);
  const { features = [], fixes = [] } = manifest.changelog ?? {};
  const sections = [...(isDevVersion(manifest.version) ? [pluginDevNotesLine(manifest.version)] : []), `Plugin ${manifest.name} ${manifest.version} for ${manifest.target ?? manifest.role} (${manifest.arch}, plugin protocol ${manifest.protocolVersion}). Needs agent ${manifest.minAgentVersion} or later.`];
  if (features.length) sections.push(['Features:', ...features.map(entry => `- ${entry}`)].join('\n'));
  if (fixes.length) sections.push(['Fixes:', ...fixes.map(entry => `- ${entry}`)].join('\n'));
  sections.push(`The manifest signature checks against ServerDesk/${publicKeyFile}.`);
  return sections.join('\n\n');
}

/**
 * Copies the build artifact into the checkout, but only the two files the build
 * job uploads: the artifact metadata and the published EXE. The build job runs
 * third-party code, so its artifact may hold anything: a link, a script or a
 * key file would otherwise replace a file of the checkout before the signing
 * step runs that checkout with the key.
 * @param {{ from: string, to: string, name: string, version: string }} input
 * @returns {string[]} the copied paths, relative and with "/"
 */
export function stagePluginBuild({ from, to, name, version }) {
  if (!isReleaseVersion(version)) throw new Error(`Plugin version "${version}" must be X.Y.Z or X.Y.Z-dev.<sha7>.`);
  const paths = pluginPaths(name), required = [paths.artifact, `${paths.publish}/${paths.exe}`];
  const directories = new Set(['.build', paths.publish]);
  const files = [];
  const walk = relative => {
    for (const entry of readdirSync(path.join(from, relative)).sort()) {
      const item = relative ? `${relative}/${entry}` : entry;
      const stat = lstatSync(path.join(from, item));
      if (stat.isSymbolicLink()) throw new Error(`The build artifact has a link: ${item}.`);
      if (stat.isDirectory() && directories.has(item)) walk(item);
      else if (stat.isFile() && required.includes(item)) files.push(item);
      else throw new Error(`The build artifact has an unexpected entry: ${item}.`);
    }
  };
  walk('');
  for (const entry of required) if (!files.includes(entry)) throw new Error(`The build artifact has no ${entry}.`);
  let metadata;
  try { metadata = JSON.parse(readFileSync(path.join(from, paths.artifact), 'utf8')); } catch { throw new Error(`${paths.artifact} in the build artifact is not valid JSON.`); }
  if (metadata?.name !== name || metadata?.version !== version) throw new Error(`The build artifact is ${metadata?.name} ${metadata?.version}, not ${name} ${version}.`);
  for (const entry of files) {
    mkdirSync(path.dirname(path.join(to, entry)), { recursive: true });
    copyFileSync(path.join(from, entry), path.join(to, entry));
  }
  return files;
}

/** Size and SHA-256 of the published EXE, for the approver to compare. */
export function pluginBuildDigests(directory, name, version) {
  const paths = pluginPaths(name), bytes = readFileSync(path.join(directory, paths.publish, paths.exe));
  return [{ name: pluginReleaseFiles(name, version).exe, size: bytes.length, sha256: sha256(bytes) }];
}

function showDigests(name, version, heading, env) {
  const rows = pluginBuildDigests('.', name, version);
  for (const row of rows) console.log(`${row.name}: ${row.size} bytes, SHA-256 ${row.sha256}`);
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, [`### ${heading}`, '', '| File | Bytes | SHA-256 |', '| --- | --- | --- |', ...rows.map(row => `| ${row.name} | ${row.size} | \`${row.sha256}\` |`), '', ''].join('\n'));
  }
}

// CLI, run in ServerDesk (all paths are relative to the current directory):
//   plan --plugin <name>                                   the workflow plan (GITHUB_OUTPUT or JSON)
//   digests --plugin <name> --version <v>                  size and SHA-256 of the build (also to GITHUB_STEP_SUMMARY)
//   stage --plugin <name> --dir <dir> --version <v>        copy only the expected build files from <dir> into the checkout
//   assets --plugin <name> --out <dir> --version <v>       verify the signed record of the build and collect the assets
//   verify --plugin <name> --dir <dir> --version <v> [--check-notes]
//                                                          verify the collected assets with the pinned key
// <v> is X.Y.Z or a dev version X.Y.Z-dev.<sha7>.
// notes.md is not signed, and the notes text of the checkout can change after
// assets wrote it. So verify compares notes.md only with --check-notes (the release
// workflow checks the notes that it wrote itself). Without the option, a cached and
// correctly signed release folder still verifies.
const usage = 'Usage: node scripts/plugin-release.mjs plan --plugin <name> | digests --plugin <name> --version X.Y.Z | stage --plugin <name> --dir <dir> --version X.Y.Z | assets --plugin <name> --out <dir> --version X.Y.Z | verify --plugin <name> --dir <dir> --version X.Y.Z [--check-notes]';

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || result.error?.message || '').trim()}`);
  return result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

/** The text of a file, or null when it is missing. */
function readText(file) {
  try { return readFileSync(file, 'utf8'); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

/** A missing file gives null; a file with invalid JSON stops the run. */
function readJson(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  try { return JSON.parse(text); } catch { throw new Error(`${file} is not valid JSON.`); }
}

function plan(name, env) {
  const paths = pluginPaths(name);
  let csproj;
  try { csproj = readFileSync(paths.project, 'utf8'); } catch { throw new Error(`The plugin ${name} has no project file ${paths.project}.`); }
  const version = /<Version>([^<]*)<\/Version>/.exec(csproj)?.[1] ?? '';
  const ref = env.GITHUB_REF || git(['rev-parse', '--symbolic-full-name', 'HEAD'])[0] || '';
  // Only a release from main reads the changelog; a dev build needs none.
  const changelog = ref === 'refs/heads/main' && isBaseVersion(version) ? readJson(`${paths.changelogs}/${version}.json`) : null;
  // The commit of the run: a dev version carries its first 7 characters.
  const sha = env.GITHUB_SHA || git(['rev-parse', 'HEAD'])[0] || '';
  const tags = git(['tag', '--list', `plugin-${name}-v*`]);
  const result = planPluginRelease({ csproj, ref, tags, name, changelog, sha });
  const notice = result.prerelease
    ? `Plugin ${name} ${result.version} is already released as ${result.tag}. Push a new commit to dev to build a new dev release.`
    : `Plugin ${name} ${result.version} is already released as ${result.tag}. Increase <Version> to release a new plugin version.`;
  const outputs = { name, version: result.version, tag: result.tag, release: String(result.release), prerelease: String(result.prerelease) };
  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''));
    console.log(result.release ? `Release ${result.tag}.` : `::notice::${notice}`);
  } else {
    if (!result.release) console.error(notice);
    console.log(JSON.stringify(outputs, null, 2));
  }
}

function assets(name, values) {
  if (!values.out || !values.version) throw new Error(usage);
  const paths = pluginPaths(name), record = readJson(paths.record);
  if (!record) throw new Error(`${paths.record} is missing. Run scripts/sign-plugin-release.mjs first.`);
  const publicKeyPem = readFileSync(publicKeyFile);
  // The record first, so an unsigned record stops with its own message before any file read.
  verifyPluginRelease({ record, publicKeyPem, name, version: values.version });
  const exe = readFileSync(path.join(paths.publish, paths.exe));
  verifyPluginRelease({ record, files: { exe }, publicKeyPem, name, version: values.version });
  mkdirSync(values.out, { recursive: true });
  for (const asset of pluginReleaseAssets(record)) writeFileSync(path.join(values.out, asset.name), asset.content);
  // The verified bytes, not a second read of the file.
  writeFileSync(path.join(values.out, pluginReleaseFiles(name, values.version).exe), exe);
  writeFileSync(path.join(values.out, 'notes.md'), pluginReleaseNotes(record) + '\n');
  console.log(`Plugin ${name} ${values.version}: release assets in ${values.out}.`);
}

function verify(name, values) {
  if (!values.dir || !values.version) throw new Error(usage);
  const names = pluginReleaseFiles(name, values.version);
  const read = file => readFileSync(path.join(values.dir, file));
  let record;
  try { record = JSON.parse(read(names.record).toString('utf8')); } catch { throw new Error(`${names.record} is missing or not valid JSON.`); }
  // Always the pinned key of this checkout: there is no option for another key.
  verifyPluginRelease({ record, files: { exe: read(names.exe) }, publicKeyPem: readFileSync(publicKeyFile), name, version: values.version });
  for (const asset of pluginReleaseAssets(record)) {
    if (read(asset.name).toString('utf8') !== asset.content) throw new Error(`${asset.name} does not match the signed manifest.`);
  }
  if (values['check-notes'] && readText(path.join(values.dir, 'notes.md')) !== pluginReleaseNotes(record) + '\n') {
    throw new Error('notes.md does not match the signed manifest.');
  }
  console.log(`Plugin ${name} ${values.version}: the release assets match the signature of ${publicKeyFile}.`);
}

function cli(argv, env) {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { plugin: { type: 'string' }, out: { type: 'string' }, dir: { type: 'string' }, version: { type: 'string' }, 'check-notes': { type: 'boolean' } },
  });
  const [command, ...rest] = positionals;
  if (rest.length || !values.plugin) throw new Error(usage);
  if (values['check-notes'] && command !== 'verify') throw new Error(usage);
  const name = values.plugin;
  pluginPaths(name);
  if (values.version !== undefined && !isReleaseVersion(values.version)) throw new Error(`Plugin version "${values.version}" must be X.Y.Z or X.Y.Z-dev.<sha7>.`);
  if (command === 'plan' && !values.out && !values.dir && !values.version) return plan(name, env);
  if (command === 'digests' && values.version && !values.out && !values.dir) return showDigests(name, values.version, `Plugin ${name} ${values.version} build`, env);
  if (command === 'stage' && values.dir && values.version && !values.out) {
    const files = stagePluginBuild({ from: values.dir, to: '.', name, version: values.version });
    console.log(`Copied ${files.length} build files: ${files.join(', ')}.`);
    return showDigests(name, values.version, `Plugin ${name} ${values.version} build to sign`, env);
  }
  if (command === 'assets' && !values.dir) return assets(name, values);
  if (command === 'verify' && !values.out) return verify(name, values);
  throw new Error(usage);
}

const direct = process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (direct) {
  try { cli(process.argv.slice(2), process.env); } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
