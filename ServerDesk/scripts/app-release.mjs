import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// The release plan of the app image (.github/workflows/docker-image.yml).
// The Git tags vX.Y.Z are the only source of the version: the CI never
// commits, and package.json stays as it is.

export const releaseTypes = ['patch', 'minor', 'none'];
const releaseTag = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const firstVersion = [0n, 1n, 0n];
// The branches that may build an image without a release, and their channel.
const imageChannels = new Map([['refs/heads/main', 'edge'], ['refs/heads/dev', 'dev']]);

/** Returns [major, minor, patch] for a release tag such as v1.2.3, otherwise null. */
export function parseReleaseTag(tag) {
  const match = typeof tag === 'string' ? releaseTag.exec(tag) : null;
  return match ? match.slice(1, 4).map(part => BigInt(part)) : null;
}

const compare = (left, right) => {
  for (let index = 0; index < 3; index++) if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  return 0;
};

/** The highest release tag by numeric comparison; pre-release and other tags do not count. */
export function latestReleaseTag(tags) {
  let latest = null;
  for (const tag of tags) {
    const version = parseReleaseTag(tag);
    if (version && (!latest || compare(version, latest.version) > 0)) latest = { tag, version };
  }
  return latest;
}

/**
 * Plans one run of the image workflow. `patch` and `minor` give the next
 * version after the highest vX.Y.Z tag (v0.1.0 when there is none) and run
 * only from main. `none` gives no tag: edge-<sha7> on main and dev-<sha7> on
 * dev. The channel selects the image tags in docker-image.yml.
 * @param {{ bump: string, ref: string, tags?: string[], headTags?: string[], sha?: string }} input
 * @returns {{ release: boolean, version: string, tag: string | null, previousTag: string | null, channel: 'release' | 'edge' | 'dev' }}
 */
export function planRelease({ bump, ref, tags = [], headTags = [], sha = '' }) {
  if (!releaseTypes.includes(bump)) throw new Error(`Unknown release type "${bump}". Use patch, minor or none.`);
  const latest = latestReleaseTag(tags);
  if (bump === 'none') {
    const channel = imageChannels.get(ref);
    if (!channel) throw new Error(`Image builds without a release run only from main or dev (got ${ref}).`);
    if (!/^[0-9a-f]{7,64}$/i.test(sha)) throw new Error(`An image build needs the commit SHA (got "${sha}").`);
    return { release: false, version: `${channel}-${sha.slice(0, 7).toLowerCase()}`, tag: null, previousTag: latest?.tag ?? null, channel };
  }
  if (ref !== 'refs/heads/main') throw new Error(`Releases run only from main (got ${ref}).`);
  const released = headTags.find(tag => parseReleaseTag(tag));
  if (released) throw new Error(`HEAD is already released as ${released}. Push a new commit first.`);
  const [major, minor, patch] = latest?.version ?? [];
  const next = !latest ? firstVersion : bump === 'minor' ? [major, minor + 1n, 0n] : [major, minor, patch + 1n];
  const version = next.join('.');
  return { release: true, version, tag: `v${version}`, previousTag: latest?.tag ?? null, channel: 'release' };
}

/** The text before the generated notes of a GitHub release. */
export function releaseNotesHeader({ image, version }) {
  return `Image: \`docker pull ${image}:${version}\``;
}

const hubImage = /^(?:docker\.io\/)?([a-z0-9]+(?:[._-][a-z0-9]+)*)\/([a-z0-9]+(?:[._-][a-z0-9]+)*)$/;
const imageTag = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

/** The anonymous Docker Hub API URL of one image tag. Only [docker.io/]<namespace>/<repo> images. */
export function dockerHubTagUrl(image, tag) {
  const match = typeof image === 'string' ? hubImage.exec(image) : null;
  if (!match) throw new Error(`Image "${image}" must be docker.io/<namespace>/<repository>.`);
  if (typeof tag !== 'string' || !imageTag.test(tag)) throw new Error(`Image tag "${tag}" is not valid.`);
  return `https://hub.docker.com/v2/namespaces/${match[1]}/repositories/${match[2]}/tags/${tag}`;
}

/** 404 is the only pass: 200 means the version is taken, any other status fails closed. */
export function dockerHubTagCheck(status, image, tag) {
  if (status === 404) return;
  if (status === 200) throw new Error(`Docker Hub already has ${image}:${tag}. Re-run the failed jobs of the first run, or delete the Docker Hub tag first.`);
  throw new Error(`Cannot check Docker Hub for ${image}:${tag} (HTTP ${status}).`);
}

// CLI: node scripts/app-release.mjs plan --bump <patch|minor|none> [--image <name>]
//      node scripts/app-release.mjs check-hub --image <name> --version <X.Y.Z>
const usage = 'Usage: node scripts/app-release.mjs plan --bump <patch|minor|none> [--image docker.io/<owner>/<name>] | check-hub --image docker.io/<owner>/<name> --version X.Y.Z';
const defaultImage = 'docker.io/lostindreamz/nodiverna';

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || result.error?.message || '').trim()}`);
  return result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

async function checkHub({ image, version }) {
  const url = dockerHubTagUrl(image, version);
  let status;
  try { status = (await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) })).status; } catch (error) {
    throw new Error(`Cannot check Docker Hub for ${image}:${version} (${error instanceof Error ? error.message : String(error)}).`);
  }
  dockerHubTagCheck(status, image, version);
  console.log(`Docker Hub has no ${image}:${version} yet.`);
}

async function cli(argv, env) {
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: { bump: { type: 'string' }, image: { type: 'string' }, version: { type: 'string' } } });
  if (positionals.length === 1 && positionals[0] === 'check-hub' && values.image !== undefined && values.version !== undefined && values.bump === undefined) return checkHub(values);
  if (positionals.length !== 1 || positionals[0] !== 'plan' || values.bump === undefined || values.version !== undefined) throw new Error(usage);
  const ref = env.GITHUB_REF || git(['rev-parse', '--symbolic-full-name', 'HEAD'])[0] || '';
  const sha = env.GITHUB_SHA || git(['rev-parse', 'HEAD'])[0] || '';
  const tags = git(['tag', '--list', 'v*']);
  const headTags = git(['tag', '--points-at', 'HEAD', '--list', 'v*']);
  const plan = planRelease({ bump: values.bump, ref, tags, headTags, sha });
  const outputs = {
    version: plan.version,
    tag: plan.tag ?? '',
    previous_tag: plan.previousTag ?? '',
    release: String(plan.release),
    channel: plan.channel,
    notes: plan.release ? releaseNotesHeader({ image: values.image || defaultImage, version: plan.version }) : '',
  };
  if (env.GITHUB_OUTPUT) {
    // A random delimiter keeps the multi-line notes in one output value.
    const lines = Object.entries(outputs).map(([key, value]) => {
      if (!value.includes('\n')) return `${key}=${value}\n`;
      const delimiter = `EOF_${randomUUID()}`;
      return `${key}<<${delimiter}\n${value}\n${delimiter}\n`;
    });
    appendFileSync(env.GITHUB_OUTPUT, lines.join(''));
    console.log(plan.release ? `Release ${plan.tag} (previous ${plan.previousTag ?? 'none'}).` : `Image build ${plan.version} (${plan.channel}), no release.`);
  } else {
    console.log(JSON.stringify(outputs, null, 2));
  }
}

const direct = process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (direct) {
  cli(process.argv.slice(2), process.env).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
