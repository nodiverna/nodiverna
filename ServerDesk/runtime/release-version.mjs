// The version form of agent and plugin releases (docs/self-hosting.md, "Agent
// releases from GitHub"). A release is X.Y.Z without leading zeros. A dev
// pre-release from the dev branch is X.Y.Z-dev.<sha7>: the base X.Y.Z of the
// project file and the first 7 lowercase hex characters of the commit SHA.
// The one place of this rule in JavaScript and TypeScript: the release scripts,
// the record checks, the zod schemas, the catalog, the device offers and the
// heartbeat schema all use it. Plain JavaScript with Node built-ins only: the
// sign and release jobs of the workflows and the offline CLI scripts/selfhost.mjs
// run it without a package install. The agent has the same rule in C#
// (agent/v3/ReleaseVersion.cs, agent/plugins/shared/PluginProtocol.cs).

const number = '(?:0|[1-9]\\d*)';
/** The pattern source of a base version X.Y.Z without leading zeros. */
export const baseVersionSource = `${number}\\.${number}\\.${number}`;
/** The pattern source of the dev suffix -dev.<sha7>. */
export const devSuffixSource = '-dev\\.[0-9a-f]{7}';
/** The pattern source of a release version: X.Y.Z with an optional dev suffix. */
export const releaseVersionSource = `${baseVersionSource}(?:${devSuffixSource})?`;
/** A base version X.Y.Z, also the form of a minimum agent version. */
export const baseVersionPattern = new RegExp(`^${baseVersionSource}$`);
/** A release version: X.Y.Z or X.Y.Z-dev.<sha7>. */
export const releaseVersionPattern = new RegExp(`^${releaseVersionSource}$`);
const devVersionPattern = new RegExp(`^(${baseVersionSource})${devSuffixSource}$`);
/**
 * The same pattern with another base: `base` is a pattern source without
 * anchors (for example the major-version rule of the heartbeat), the result
 * accepts it with an optional dev suffix.
 */
export const withOptionalDevSuffix = base => new RegExp(`^(?:${base})(?:${devSuffixSource})?$`);

/** Whether the value is X.Y.Z or X.Y.Z-dev.<sha7>. */
export const isReleaseVersion = value => typeof value === 'string' && releaseVersionPattern.test(value);
/** Whether the value is X.Y.Z without a suffix. */
export const isBaseVersion = value => typeof value === 'string' && baseVersionPattern.test(value);
/** Whether the value is a valid dev version X.Y.Z-dev.<sha7>. */
export const isDevVersion = value => typeof value === 'string' && devVersionPattern.test(value);
/** The base X.Y.Z of a release version, or null for any other value. */
export function baseVersion(value) {
  if (!isReleaseVersion(value)) return null;
  return value.split('-')[0];
}

/**
 * The dev version of a base and a commit SHA: X.Y.Z-dev.<first 7 characters>.
 * The base must be X.Y.Z and the SHA 40 hex characters; it is lowercased.
 * @param {string} base
 * @param {string} sha
 */
export function devVersion(base, sha) {
  if (!isBaseVersion(base)) throw new Error(`The version "${base}" must be X.Y.Z.`);
  if (typeof sha !== 'string' || !/^[0-9a-fA-F]{40}$/.test(sha)) throw new Error('A dev build needs the 40 hex characters of the commit SHA.');
  return `${base}-dev.${sha.slice(0, 7).toLowerCase()}`;
}

const parts = value => baseVersion(value).split('.').map(Number);

/**
 * The rank order of two release versions: -1, 0 or 1, or null when one side is
 * not a release version. The base X.Y.Z counts first, numerically. For the
 * same base a release ranks above any dev build. Two dev builds of the same
 * base have the same rank: the version string has no order, so equal rank is
 * not the same version (compare the strings for that).
 * @param {unknown} left
 * @param {unknown} right
 * @returns {-1|0|1|null}
 */
export function compareReleaseRank(left, right) {
  if (!isReleaseVersion(left) || !isReleaseVersion(right)) return null;
  const a = parts(left), b = parts(right);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  const devLeft = isDevVersion(left), devRight = isDevVersion(right);
  if (devLeft === devRight) return 0;
  return devLeft ? -1 : 1;
}

/**
 * The version of a build (scripts/build-agent-v3.mjs, scripts/build-plugin.mjs):
 * the project version without a requested version, else the requested version
 * of the workflow plan, which must be the project version or the project
 * version with a valid -dev.<sha7> suffix. Anything else stops the build.
 * @param {string} project the <Version> of the project file
 * @param {string | undefined} requested for example SERVERDESK_AGENT_VERSION
 * @returns {{ version: string, devSuffix: string }} devSuffix is '' or -dev.<sha7>
 */
export function buildVersion(project, requested) {
  if (requested === undefined || requested === '') return { version: project, devSuffix: '' };
  if (requested === project) return { version: project, devSuffix: '' };
  if (isDevVersion(requested) && baseVersion(requested) === project) return { version: requested, devSuffix: requested.slice(project.length) };
  throw new Error(`The build version "${requested}" must be ${project} or ${project}-dev.<sha7>.`);
}
