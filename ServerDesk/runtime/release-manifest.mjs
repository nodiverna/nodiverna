// Agent release manifests have the path form (agents from 4.12.0): each file is
// named by a path below /downloads/ without an origin, so one publisher
// signature is valid on every installation. The portal refuses the older
// absolute form, which named each file by an HTTPS URL on one portal origin.
// A file entry is the manifest itself, each item of `parts`, `exe` and each
// item of `exe.parts`.

const downloadPathPattern = /^\/downloads\/[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/**
 * Whether a value is a valid file path of the path form: one file name directly
 * below /downloads/, no "..", no query, no encoding and no backslash.
 * @param {unknown} value
 * @returns {value is string}
 */
export function isReleaseDownloadPath(value) {
  return typeof value === 'string' && downloadPathPattern.test(value) && !value.includes('..');
}

/**
 * The file entries of a parsed manifest in a fixed order: the manifest, its
 * parts, the EXE and the EXE parts. Throws on a structure that is not an object.
 * @param {any} manifest
 * @returns {Record<string, unknown>[]}
 */
export function releaseFileEntries(manifest) {
  const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
  if (!isObject(manifest)) throw new Error('Invalid release manifest.');
  const entries = [manifest];
  if (manifest.parts !== undefined) {
    if (!Array.isArray(manifest.parts)) throw new Error('Invalid release parts.');
    entries.push(...manifest.parts);
  }
  if (manifest.exe !== undefined) {
    if (!isObject(manifest.exe)) throw new Error('Invalid executable manifest.');
    entries.push(manifest.exe);
    if (manifest.exe.parts !== undefined) {
      if (!Array.isArray(manifest.exe.parts)) throw new Error('Invalid executable parts.');
      entries.push(...manifest.exe.parts);
    }
  }
  if (entries.some(entry => !isObject(entry))) throw new Error('Invalid release file entry.');
  return entries;
}

/**
 * The form of a parsed manifest: 'path' when every file entry has `path`,
 * 'url' when every file entry has `url`. An entry with both keys or with none,
 * and a manifest with entries of both forms, are invalid.
 * @param {any} manifest
 * @returns {'path' | 'url'}
 */
export function releaseManifestForm(manifest) {
  const forms = new Set(releaseFileEntries(manifest).map(entry => {
    const hasPath = Object.hasOwn(entry, 'path'), hasUrl = Object.hasOwn(entry, 'url');
    if (hasPath === hasUrl) throw new Error('A release file entry must have either a path or a URL.');
    return hasPath ? 'path' : 'url';
  }));
  if (forms.size !== 1) throw new Error('The release mixes file paths and URLs.');
  return forms.has('path') ? 'path' : 'url';
}
