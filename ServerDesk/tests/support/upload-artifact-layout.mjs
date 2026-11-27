// The artifact layout of actions/upload-artifact (v4 and later, pinned v7.0.2),
// for the release workflow tests: which files a `path` input uploads and under
// which entry names they arrive in the artifact.
// The rule, as upload-artifact computes it with @actions/glob:
// - Each path line is a search path. A literal line is its own search path; for
//   a glob pattern it is the part before the first segment with a wildcard.
//   Duplicates and search paths below another search path are dropped.
// - With more than one search path, the artifact root is their longest common
//   ancestor by path segments. With one search path that is exactly the one
//   uploaded file, the root is its folder; otherwise the root is the search path.
// - Every file is stored relative to the root; download-artifact with `name`
//   extracts the entries directly into its `path`.
// Paths are relative to the workspace and use "/". Node built-ins only.
import path from 'node:path';

const wildcard = /[*?[]/;
const clean = line => {
  const value = path.posix.normalize(line.trim()).replace(/\/+$/, '');
  if (!value || value.startsWith('!') || value.startsWith('/') || value === '..' || value.startsWith('../')) throw new Error(`The upload path "${line}" is not supported here.`);
  return value;
};
const segments = value => (value === '.' ? [] : value.split('/'));
const isWithin = (file, folder) => folder === '.' || file === folder || file.startsWith(`${folder}/`);

/** The search path of one path line: the literal segments before the first segment with a wildcard. */
export function uploadSearchPath(line) {
  const parts = segments(clean(line));
  const first = parts.findIndex(part => wildcard.test(part));
  const literal = first < 0 ? parts : parts.slice(0, first);
  return literal.length ? literal.join('/') : '.';
}

/** A glob segment as a regular expression: `*` and `?` stay inside one segment. */
const segmentPattern = part => new RegExp(`^${part.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`);

/**
 * The files of the workspace that one path line uploads: the file itself for a
 * literal file, every file below a literal folder, the matches of a glob (`**`
 * matches any number of folders).
 * @param {string} line
 * @param {string[]} workspaceFiles every file of the workspace, relative with "/"
 * @returns {string[]}
 */
export function filesOfUploadPath(line, workspaceFiles) {
  const pattern = segments(clean(line));
  if (!pattern.some(part => wildcard.test(part))) {
    const literal = pattern.join('/');
    return workspaceFiles.filter(file => isWithin(file, literal));
  }
  const matches = (parts, at, index) => {
    if (at === pattern.length) return index === parts.length;
    if (pattern[at] === '**') {
      for (let skip = index; skip <= parts.length; skip++) if (matches(parts, at + 1, skip)) return true;
      return false;
    }
    return index < parts.length && segmentPattern(pattern[at]).test(parts[index]) && matches(parts, at + 1, index + 1);
  };
  return workspaceFiles.filter(file => matches(file.split('/'), 0, 0));
}

/**
 * The artifact root and the entry name of every uploaded file.
 * @param {string[]} lines the path lines of the upload step
 * @param {Map<string, string[]> | Record<string, string[]>} uploaded the files each line uploads
 * @returns {{ root: string, entries: { file: string, entry: string }[] }}
 */
export function uploadArtifactLayout(lines, uploaded) {
  const byLine = uploaded instanceof Map ? uploaded : new Map(Object.entries(uploaded));
  const used = lines.map(line => line.trim()).filter(Boolean);
  if (!used.length) throw new Error('The upload step has no path.');
  const files = [];
  for (const line of used) {
    const search = uploadSearchPath(line), found = byLine.get(line) ?? byLine.get(line.trim());
    if (!found?.length) throw new Error(`The upload path "${line}" uploads no file.`);
    for (const file of found.map(clean)) {
      if (!isWithin(file, search)) throw new Error(`${file} is not below the search path ${search} of "${line}".`);
      if (!files.includes(file)) files.push(file);
    }
  }
  // Unique search paths without those below another one, in the order of the lines.
  const unique = [...new Set(used.map(uploadSearchPath))];
  const searchPaths = unique.filter(candidate => !unique.some(other => other !== candidate && isWithin(candidate, other)));
  let root;
  if (searchPaths.length > 1) {
    const split = searchPaths.map(segments);
    const common = [];
    for (let index = 0; index < Math.min(...split.map(parts => parts.length)); index++) {
      if (!split.every(parts => parts[index] === split[0][index])) break;
      common.push(split[0][index]);
    }
    root = common.length ? common.join('/') : '.';
  } else if (files.length === 1 && files[0] === searchPaths[0]) {
    root = path.posix.dirname(files[0]);
  } else {
    root = searchPaths[0];
  }
  return { root, entries: files.map(file => ({ file, entry: root === '.' ? file : file.slice(root.length + 1) })) };
}
