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

const ghcrImage = /^ghcr\.io\/([a-z0-9]+(?:[._-][a-z0-9]+)*)\/([a-z0-9]+(?:[._-][a-z0-9]+)*)$/;
const hubImage = /^(docker\.io\/)?([a-z0-9]+(?:[._-][a-z0-9]+)*)\/([a-z0-9]+(?:[._-][a-z0-9]+)*)$/;
const imageTag = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const imageError = image => new Error(`Image "${image}" must be ghcr.io/<owner>/<repository> or docker.io/<namespace>/<repository>.`);

/**
 * The registry of an image: ghcr.io/<owner>/<repo>, or Docker Hub as docker.io/<ns>/<repo>
 * or <ns>/<repo> (the old image name stays accepted). Without the docker.io prefix, a first
 * part with a dot or localhost is a registry host for Docker, so it is refused.
 * @returns {{ registry: 'ghcr.io' | 'docker.io', owner: string, repository: string }}
 */
function parseImage(image) {
  if (typeof image !== 'string') throw imageError(image);
  const ghcr = ghcrImage.exec(image);
  if (ghcr) return { registry: 'ghcr.io', owner: ghcr[1], repository: ghcr[2] };
  const hub = hubImage.exec(image);
  if (hub && (hub[1] || (!hub[2].includes('.') && hub[2] !== 'localhost'))) return { registry: 'docker.io', owner: hub[2], repository: hub[3] };
  throw imageError(image);
}

/** The URL that tells whether one image tag exists: the GHCR manifest, or the anonymous Docker Hub API. */
export function registryTagUrl(image, tag) {
  const { registry, owner, repository } = parseImage(image);
  if (typeof tag !== 'string' || !imageTag.test(tag)) throw new Error(`Image tag "${tag}" is not valid.`);
  return registry === 'ghcr.io'
    ? `https://ghcr.io/v2/${owner}/${repository}/manifests/${tag}`
    : `https://hub.docker.com/v2/namespaces/${owner}/repositories/${repository}/tags/${tag}`;
}

/** 404 is the only pass: 200 means the version is taken, any other status fails closed. */
export function registryTagCheck(status, image, tag) {
  if (status === 404) return;
  if (status === 200) throw new Error(`The registry already has ${image}:${tag}. Re-run the failed jobs of the first run, or delete the tag first.`);
  throw new Error(`Cannot check the registry for ${image}:${tag} (HTTP ${status}).`);
}

// Every manifest type a GHCR tag can have: a HEAD with this list gets 200 for any of them.
const manifestTypes = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

/**
 * Stops a release whose version the registry has already. GHCR: a pull token
 * (HTTP Basic with REGISTRY_USERNAME and REGISTRY_TOKEN when both are set,
 * anonymous otherwise), then HEAD on the manifest. Docker Hub: the anonymous API.
 * Every failure fails closed, and no message contains the token.
 */
export async function checkRegistry({ image, version }, { env = process.env, fetch: request = fetch, log = console.log } = {}) {
  const url = registryTagUrl(image, version);
  const { registry, owner, repository } = parseImage(image);
  const options = { redirect: 'error', signal: AbortSignal.timeout(30_000) };
  const fail = reason => new Error(`Cannot check the registry for ${image}:${version} (${reason}).`);
  let status;
  try {
    if (registry === 'ghcr.io') {
      const headers = {};
      if (env.REGISTRY_USERNAME && env.REGISTRY_TOKEN) headers.Authorization = `Basic ${Buffer.from(`${env.REGISTRY_USERNAME}:${env.REGISTRY_TOKEN}`).toString('base64')}`;
      const tokenResponse = await request(`https://ghcr.io/token?service=ghcr.io&scope=repository:${owner}/${repository}:pull`, { ...options, headers });
      if (tokenResponse.status !== 200) throw fail(`token request HTTP ${tokenResponse.status}`);
      let body;
      try { body = await tokenResponse.json(); } catch { throw fail('the token answer is not JSON'); }
      const token = body?.token;
      if (typeof token !== 'string' || !token) throw fail('the token answer has no token');
      status = (await request(url, { ...options, method: 'HEAD', headers: { Authorization: `Bearer ${token}`, Accept: manifestTypes } })).status;
    } else {
      status = (await request(url, options)).status;
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Cannot check the registry for ')) throw error;
    throw fail(error instanceof Error ? error.message : String(error));
  }
  registryTagCheck(status, image, version);
  log(`The registry has no ${image}:${version} yet.`);
}

// CLI: node scripts/app-release.mjs plan --bump <patch|minor|none> [--image <name>]
//      node scripts/app-release.mjs check-registry --image <name> --version <X.Y.Z>
const usage = 'Usage: node scripts/app-release.mjs plan --bump <patch|minor|none> [--image ghcr.io/<owner>/<name>] | check-registry --image ghcr.io/<owner>/<name> --version X.Y.Z';
const defaultImage = 'ghcr.io/nodiverna/nodiverna';

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || result.error?.message || '').trim()}`);
  return result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

async function cli(argv, env) {
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: { bump: { type: 'string' }, image: { type: 'string' }, version: { type: 'string' } } });
  if (positionals.length === 1 && positionals[0] === 'check-registry' && values.image !== undefined && values.version !== undefined && values.bump === undefined) return checkRegistry(values);
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
