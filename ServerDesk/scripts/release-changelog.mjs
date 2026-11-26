import { baseVersion, isDevVersion } from '../runtime/release-version.mjs';

/** Publisher-maintained release notes become part of the signed manifest. */
export function validateReleaseChangelog(value, version) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== version || Object.keys(value).some(key => !['version', 'features', 'fixes'].includes(key))) {
    throw new Error(`Release notes must name version ${version} and contain only version, features and fixes.`);
  }
  const entries = name => {
    const list = value[name];
    if (!Array.isArray(list) || list.length > 10 || list.some(entry => typeof entry !== 'string' || !entry.trim() || entry.trim().length > 200 || /[\u0000-\u001f\u007f]/.test(entry))) {
      throw new Error(`Release notes ${name} must contain at most 10 nonempty entries of at most 200 characters.`);
    }
    return list.map(entry => entry.trim());
  };
  const changelog = { features: entries('features'), fixes: entries('fixes') };
  if (!changelog.features.length && !changelog.fixes.length) throw new Error('A new Agent release requires at least one feature or bugfix.');
  return changelog;
}

/**
 * The changelog of a dev build X.Y.Z-dev.<sha7>: the changelog file of the base
 * X.Y.Z when it exists and is valid for the base, else one generated line that
 * names the commit. `text` is the content of changelogs/X.Y.Z.json or null.
 * @param {string | null} text
 * @param {string} version a dev version
 */
export function devReleaseChangelog(text, version) {
  const base = baseVersion(version);
  if (!isDevVersion(version) || !base) throw new Error(`The version "${version}" is not a dev version X.Y.Z-dev.<sha7>.`);
  if (text !== null) {
    try { return validateReleaseChangelog(JSON.parse(text), base); } catch { /* the generated line below */ }
  }
  return { features: [`Dev build from commit ${version.slice(-7)}.`], fixes: [] };
}
