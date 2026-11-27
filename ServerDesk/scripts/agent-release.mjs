import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { appendFileSync, copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { validateReleaseChangelog } from './release-changelog.mjs';
import { agentReleaseFiles, verifyAgentRelease } from '../runtime/agent-release-verify.mjs';
import { baseVersion, compareReleaseRank, devVersion, isBaseVersion, isDevVersion, isReleaseVersion } from '../runtime/release-version.mjs';

// The agent release from the CI (.github/workflows/agent-release.yml).
// The plan reads <Version> from the project file and stops when the tag
// agent-vX.Y.Z exists. A run on dev plans the pre-release
// agent-vX.Y.Z-dev.<sha7> with the first 7 characters of the commit SHA
// (runtime/release-version.mjs); it needs no changelog file. verify checks a record from scripts/sign-agent-release.mjs
// against the pinned publisher key, and assets collects the GitHub release files
// from .build/. The record has the path form (files below /downloads/ without
// an origin), so the release assets are valid on every installation. The CI
// never commits; portals import the release from GitHub or a folder.

const projectFile = 'agent/v3/ServerDesk.Agent.csproj';
/** The signed record of scripts/sign-agent-release.mjs. */
export const signedRecordFile = '.build/agent-v3-release.json';
const publicKeyFile = 'agent/v3/release-public.pem';

/**
 * Plans one run of the agent workflow from the project file, the ref, the
 * commit SHA and the agent-v* tags only. Pure: the caller reads the file, the
 * SHA and the tags. main releases X.Y.Z. dev builds the pre-release
 * X.Y.Z-dev.<sha7>; its base X.Y.Z must not be released yet, because a dev build
 * ranks below the release of its base.
 * @param {{ csproj: string, ref: string, tags?: string[], sha?: string }} input
 * @returns {{ version: string, tag: string, release: boolean, prerelease: boolean }}
 */
export function planAgentRelease({ csproj, ref, tags = [], sha }) {
  const base = typeof csproj === 'string' ? /<Version>([^<]*)<\/Version>/.exec(csproj)?.[1] : undefined;
  if (!base) throw new Error(`Agent version missing in ${projectFile}.`);
  if (!isBaseVersion(base)) throw new Error(`Agent version "${base}" in ${projectFile} must be X.Y.Z.`);
  if (ref === 'refs/heads/main') {
    const tag = `agent-v${base}`;
    return { version: base, tag, release: !tags.includes(tag), prerelease: false };
  }
  if (ref !== 'refs/heads/dev') throw new Error(`Agent releases run only from main or dev (got ${ref}).`);
  const version = devVersion(base, sha), baseTag = `agent-v${base}`, tag = `agent-v${version}`;
  if (tags.includes(baseTag)) throw new Error(`Agent ${base} is already released as ${baseTag}. Increase <Version> on dev to build a dev release.`);
  return { version, tag, release: !tags.includes(tag), prerelease: true };
}

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
// The record check is shared with the portal import (runtime/release-import.mjs).
export { agentReleaseFiles, agentReleasePartSize, verifyAgentRelease } from '../runtime/agent-release-verify.mjs';

/** The signed record, the exact signed manifest bytes and the signature as release assets. */
export function agentReleaseAssets(record) {
  const names = agentReleaseFiles(record.version);
  return [
    { name: names.record, content: JSON.stringify(record, null, 2) + '\n' },
    { name: names.manifest, content: record.manifest },
    { name: names.signature, content: record.signature },
  ];
}

/** -1, 0 or 1 for two X.Y.Z versions. */
const compareVersions = (left, right) => compareReleaseRank(left, right) ?? 0;

/**
 * The changelogs that belong in the notes of a version: same major, lower
 * version, newest first. A dev build selects by its base X.Y.Z.
 */
function earlierSelection(changelogs, version) {
  const base = baseVersion(version);
  if (!base) return [];
  const major = base.split('.')[0];
  return changelogs
    .filter(entry => isBaseVersion(entry?.version) && entry.version.split('.')[0] === major && compareVersions(entry.version, base) < 0)
    .sort((a, b) => compareVersions(b.version, a.version));
}

const changelogDirectory = 'agent/v3/changelogs';

/**
 * Every changelog in agent/v3/changelogs below the directory, validated with the
 * rules of the signing script and trimmed, newest first. A missing directory
 * gives none. A file that is not X.Y.Z.json, not JSON or not valid stops the
 * run with its name. Files without .json are ignored.
 * @param {string} directory
 * @returns {{ version: string, features: string[], fixes: string[] }[]}
 */
export function agentChangelogs(directory) {
  let names;
  try { names = readdirSync(path.join(directory, changelogDirectory)); } catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
  const changelogs = [];
  for (const name of names.filter(entry => entry.endsWith('.json')).sort()) {
    const file = `${changelogDirectory}/${name}`, version = name.slice(0, -'.json'.length);
    const invalid = reason => new Error(`${file} is not a valid changelog: ${reason}`);
    if (!isBaseVersion(version)) throw invalid('the file name must be X.Y.Z.json.');
    let value;
    try { value = JSON.parse(readFileSync(path.join(directory, file), 'utf8')); } catch { throw invalid('the file is not valid JSON.'); }
    let changelog;
    try { changelog = validateReleaseChangelog(value, version); } catch (error) { throw invalid(error instanceof Error ? error.message : String(error)); }
    changelogs.push({ version, ...changelog });
  }
  return changelogs.sort((a, b) => compareVersions(b.version, a.version));
}

/** The changelogs of agent/v3/changelogs that go into the release notes of the version (see agentReleaseNotes). */
export function earlierAgentChangelogs(directory, version) {
  return earlierSelection(agentChangelogs(directory), version);
}

/** The first line of the notes of a dev pre-release. */
export const agentDevNotesLine = version => `Dev pre-release ${version} from the dev branch. Portals import it only when an owner turns on dev builds.`;
/** GitHub refuses a release body above 125,000 characters; the notes stay below this cap. */
export const agentReleaseNotesLimit = 100000;
const changeLists = ({ features = [], fixes = [] }) => [
  ...(features.length ? [['Features:', ...features.map(entry => `- ${entry}`)].join('\n')] : []),
  ...(fixes.length ? [['Fixes:', ...fixes.map(entry => `- ${entry}`)].join('\n')] : []),
];

/**
 * The GitHub release notes: the changelog of the signed manifest first, then the
 * earlier changelogs of the same major version, newest first, because an update
 * from an older agent also contains their changes. Only the first block is
 * signed; verify --check-notes computes the earlier blocks again from the same checkout. When
 * the notes are too long, the oldest versions go and a line names the directory.
 * The notes of a dev pre-release start with agentDevNotesLine; its earlier
 * changelogs are selected by the base X.Y.Z.
 * @param {{ manifest: string }} record
 * @param {{ version: string, features: string[], fixes: string[] }[]} [earlier]
 */
export function agentReleaseNotes(record, earlier = []) {
  const manifest = JSON.parse(record.manifest);
  const current = [...(isDevVersion(manifest.version) ? [agentDevNotesLine(manifest.version)] : []),
    `Windows agent ${manifest.version} (${manifest.arch}, protocol ${manifest.protocolVersion})`, ...changeLists(manifest.changelog ?? {})];
  const selected = isReleaseVersion(manifest.version) ? earlierSelection(earlier, manifest.version) : [];
  const notes = (entries, dropped) => [
    ...current,
    ...(entries.length ? [`Earlier agent ${baseVersion(manifest.version).split('.')[0]} versions, newest first. An update from an older agent also contains these changes.`] : []),
    ...entries.flatMap(entry => [`### ${entry.version}`, ...changeLists(entry)]),
    ...(dropped ? [`Older versions: ServerDesk/${changelogDirectory} in this repository.`] : []),
    `The manifest signature checks against ServerDesk/${publicKeyFile}.`,
  ].join('\n\n');
  let kept = selected, text = notes(kept, false);
  while (text.length > agentReleaseNotesLimit && kept.length) {
    kept = kept.slice(0, -1);
    text = notes(kept, true);
  }
  return text;
}

// The build folder of the checkout. The artifact of the build job holds its files
// without this prefix (see stageAgentBuild).
const buildFolder = '.build';
const artifactDirectories = new Set(['agent-v3-publish']);
const artifactRequired = version => ['agent-v3-artifact.json', agentReleaseFiles(version).zip, 'agent-v3-publish/ServerDesk.Agent.exe'];

/**
 * Copies the build artifact into the checkout, but only the files the build job
 * uploads for this version. The build job runs third-party code, so its artifact
 * may hold anything: a link, a script or a key file would otherwise replace a
 * file of the checkout before the signing step runs that checkout with the key.
 * The artifact root is ServerDesk/.build of the build job: upload-artifact
 * stores the files relative to the common folder of the upload paths, which
 * all lie below ServerDesk/.build. So `from` holds agent-v3-artifact.json, the
 * ZIP and agent-v3-publish/ServerDesk.Agent.exe, and they go back into .build/
 * of `to`; nothing is written anywhere else in `to`. Refusals name the entry
 * relative to the artifact root, as the operator finds it in the download.
 * @param {{ from: string, to: string, version: string }} input
 * @returns {string[]} the copied paths relative to `to`, with "/" (.build/...)
 */
export function stageAgentBuild({ from, to, version }) {
  if (!isReleaseVersion(version)) throw new Error(`Agent version "${version}" must be X.Y.Z or X.Y.Z-dev.<sha7>.`);
  const required = artifactRequired(version);
  const files = [];
  const walk = relative => {
    for (const name of readdirSync(path.join(from, relative)).sort()) {
      const entry = relative ? `${relative}/${name}` : name;
      const stat = lstatSync(path.join(from, entry));
      if (stat.isSymbolicLink()) throw new Error(`The build artifact has a link: ${entry}.`);
      if (stat.isDirectory() && artifactDirectories.has(entry)) walk(entry);
      else if (stat.isFile() && required.includes(entry)) files.push(entry);
      else throw new Error(`The build artifact has an unexpected entry: ${entry}.`);
    }
  };
  walk('');
  for (const entry of required) if (!files.includes(entry)) throw new Error(`The build artifact has no ${entry}.`);
  let metadata;
  try { metadata = JSON.parse(readFileSync(path.join(from, required[0]), 'utf8')); } catch { throw new Error(`${required[0]} in the build artifact is not valid JSON.`); }
  if (metadata?.version !== version) throw new Error(`The build artifact has version ${metadata?.version}, not ${version}.`);
  for (const entry of files) {
    const target = path.join(to, buildFolder, entry);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(from, entry), target);
  }
  return files.map(entry => `${buildFolder}/${entry}`);
}

/** Size and SHA-256 of the ZIP and the EXE in .build, for the approver to compare. */
export function buildDigests(directory, version) {
  return [[agentReleaseFiles(version).zip, `.build/${agentReleaseFiles(version).zip}`], [agentReleaseFiles(version).exe, '.build/agent-v3-publish/ServerDesk.Agent.exe']]
    .map(([name, file]) => { const bytes = readFileSync(path.join(directory, file)); return { name, size: bytes.length, sha256: sha256(bytes) }; });
}

function showDigests(version, heading, env) {
  const rows = buildDigests('.', version);
  for (const row of rows) console.log(`${row.name}: ${row.size} bytes, SHA-256 ${row.sha256}`);
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, [`### ${heading}`, '', '| File | Bytes | SHA-256 |', '| --- | --- | --- |', ...rows.map(row => `| ${row.name} | ${row.size} | \`${row.sha256}\` |`), '', ''].join('\n'));
  }
}

// CLI, run in ServerDesk (all paths are relative to the current directory):
//   plan                                   the workflow plan (GITHUB_OUTPUT or JSON)
//   digests --version <v>                  size and SHA-256 of the build (also to GITHUB_STEP_SUMMARY)
//   stage --dir <dir> --version <v>        copy only the expected build files from <dir> into the checkout
//   assets --out <dir> [--version <v>]     verify .build/agent-v3-release.json and collect the assets
//   verify --dir <dir> --version <v> [--check-notes]
//                                          verify the collected assets with the pinned key
// notes.md is not signed, and an earlier changelog of the checkout can change after
// assets wrote it. So verify compares notes.md only with --check-notes (the release
// workflow checks the notes that it wrote itself). Without the option, a cached and
// correctly signed release folder still verifies.
// <v> is X.Y.Z or a dev version X.Y.Z-dev.<sha7>.
const usage = 'Usage: node scripts/agent-release.mjs plan | digests --version X.Y.Z | stage --dir <dir> --version X.Y.Z | assets --out <dir> [--version X.Y.Z] | verify --dir <dir> --version X.Y.Z [--check-notes]';

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

function plan(env) {
  const csproj = readFileSync(projectFile, 'utf8');
  const ref = env.GITHUB_REF || git(['rev-parse', '--symbolic-full-name', 'HEAD'])[0] || '';
  // The commit of the run: a dev version carries its first 7 characters.
  const sha = env.GITHUB_SHA || git(['rev-parse', 'HEAD'])[0] || '';
  const tags = git(['tag', '--list', 'agent-v*']);
  const result = planAgentRelease({ csproj, ref, tags, sha });
  if (result.release && result.prerelease) {
    // A dev build needs no changelog; its notes list the earlier changelogs, so a bad one stops the run here.
    earlierAgentChangelogs('.', result.version);
  } else if (result.release) {
    // A missing or bad changelog stops the run before the build, with the message of the signing script.
    let notes;
    try { notes = JSON.parse(readFileSync(`agent/v3/changelogs/${result.version}.json`, 'utf8')); } catch {
      throw new Error(`Add agent/v3/changelogs/${result.version}.json with version, features and fixes before publishing a new Agent release.`);
    }
    validateReleaseChangelog(notes, result.version);
    // The release notes also list the earlier changelogs: a bad one stops the run here, not after the build.
    earlierAgentChangelogs('.', result.version);
  }
  const notice = result.prerelease
    ? `Agent ${result.version} is already released as ${result.tag}. Push a new commit to dev to build a new dev release.`
    : `Agent ${result.version} is already released as ${result.tag}. Increase <Version> to release a new agent.`;
  const outputs = { version: result.version, tag: result.tag, release: String(result.release), prerelease: String(result.prerelease) };
  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''));
    console.log(result.release ? `Release ${result.tag}.` : `::notice::${notice}`);
  } else {
    if (!result.release) console.error(notice);
    console.log(JSON.stringify(outputs, null, 2));
  }
}

function assets(values) {
  if (!values.out) throw new Error(usage);
  const record = readJson(signedRecordFile);
  if (!record) throw new Error(`${signedRecordFile} is missing. Sign the build with scripts/sign-agent-release.mjs first.`);
  const version = values.version ?? record.version;
  const publicKeyPem = readFileSync(publicKeyFile);
  // The record first, so an unsigned record stops with its own message before any file read.
  verifyAgentRelease({ record, publicKeyPem, version });
  const files = {
    zip: readFileSync(path.join('.build', agentReleaseFiles(version).zip)),
    exe: readFileSync(path.join('.build', 'agent-v3-publish', 'ServerDesk.Agent.exe')),
  };
  verifyAgentRelease({ record, files, publicKeyPem, version });
  const names = agentReleaseFiles(version);
  mkdirSync(values.out, { recursive: true });
  for (const asset of agentReleaseAssets(record)) writeFileSync(path.join(values.out, asset.name), asset.content);
  // The verified bytes, not a second read of the files.
  writeFileSync(path.join(values.out, names.zip), files.zip);
  writeFileSync(path.join(values.out, names.exe), files.exe);
  writeFileSync(path.join(values.out, 'notes.md'), agentReleaseNotes(record, earlierAgentChangelogs('.', record.version)) + '\n');
  console.log(`Agent ${version}: release assets in ${values.out}.`);
}

function verify(values) {
  if (!values.dir || !values.version) throw new Error(usage);
  const names = agentReleaseFiles(values.version);
  const read = name => readFileSync(path.join(values.dir, name));
  let record;
  try { record = JSON.parse(read(names.record).toString('utf8')); } catch { throw new Error(`${names.record} is missing or not valid JSON.`); }
  // Always the pinned key of this checkout: there is no option for another key.
  verifyAgentRelease({ record, files: { zip: read(names.zip), exe: read(names.exe) }, publicKeyPem: readFileSync(publicKeyFile), version: values.version });
  for (const asset of agentReleaseAssets(record)) {
    if (read(asset.name).toString('utf8') !== asset.content) throw new Error(`${asset.name} does not match the signed manifest.`);
  }
  if (values['check-notes']) {
    // The same reader and order as assets, from the same checkout, so the text matches byte for byte.
    const notes = agentReleaseNotes(record, earlierAgentChangelogs('.', record.version)) + '\n';
    if (readText(path.join(values.dir, 'notes.md')) !== notes) throw new Error('notes.md does not match the signed manifest.');
  }
  console.log(`Agent ${values.version}: the release assets match the signature of ${publicKeyFile}.`);
}

function cli(argv, env) {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { out: { type: 'string' }, dir: { type: 'string' }, version: { type: 'string' }, 'check-notes': { type: 'boolean' } },
  });
  const [command, ...rest] = positionals;
  if (rest.length) throw new Error(usage);
  if (values['check-notes'] && command !== 'verify') throw new Error(usage);
  if (command === 'plan' && !values.out && !values.dir && !values.version) return plan(env);
  if (command === 'digests' && values.version && !values.out && !values.dir) {
    if (!isReleaseVersion(values.version)) throw new Error(`Agent version "${values.version}" must be X.Y.Z or X.Y.Z-dev.<sha7>.`);
    return showDigests(values.version, `Agent ${values.version} build`, env);
  }
  if (command === 'stage' && values.dir && values.version && !values.out) {
    const files = stageAgentBuild({ from: values.dir, to: '.', version: values.version });
    console.log(`Copied ${files.length} build files: ${files.join(', ')}.`);
    return showDigests(values.version, `Agent ${values.version} build to sign`, env);
  }
  if (command === 'assets' && !values.dir) return assets(values);
  if (command === 'verify' && !values.out) return verify(values);
  throw new Error(usage);
}

const direct = process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (direct) {
  try { cli(process.argv.slice(2), process.env); } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
