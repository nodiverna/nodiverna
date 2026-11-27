import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// Converts ServerDesk/docs/ into the pages of the GitHub wiki. The workflow
// .github/workflows/docs-wiki.yml runs it and replaces the whole wiki with the
// output. ServerDesk/docs/ stays the only source: every page starts with a
// banner that names its source file.
//
// Output: one <PageName>.md per top-level doc, Home.md with the page list,
// _Sidebar.md with the same list, and images/ as a byte copy of docs/images/.
// Links in the docs are rewritten for the wiki (rewriteLinks). The output is
// deterministic: no timestamps, no commit SHAs, LF line endings.
//
// Node built-ins only: the workflow runs this script without a package install.
// CLI: node scripts/wiki-mirror.mjs --out <dir>

export const defaultRepoUrl = 'https://github.com/nodiverna/nodiverna';
export const defaultBranch = 'main';
const reservedPages = ['home', '_sidebar', '_footer'];
const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** The wiki page name of a top-level doc: the stem with its first character in upper case. */
export function wikiPageName(fileName) {
  const base = path.posix.basename(String(fileName).replaceAll('\\', '/'));
  if (!base.endsWith('.md')) throw new Error(`${fileName} is not a Markdown file.`);
  const stem = base.slice(0, -'.md'.length);
  if (!/^[A-Za-z0-9._-]+$/.test(stem)) throw new Error(`The doc ${fileName} has a character outside [A-Za-z0-9._-] in its name.`);
  const page = stem.charAt(0).toUpperCase() + stem.slice(1);
  if (page.startsWith('_') || reservedPages.includes(page.toLowerCase())) throw new Error(`The doc ${fileName} gives the page name ${page}, which the wiki reserves.`);
  return page;
}

/**
 * The page names of a list of top-level docs as a Map from file name to page
 * name. Two names that are equal without regard to case are an error.
 */
export function wikiPageNames(fileNames) {
  const pages = new Map(), seen = new Map();
  for (const file of [...fileNames].sort()) {
    const page = wikiPageName(file), key = page.toLowerCase();
    if (seen.has(key)) throw new Error(`The docs ${seen.get(key)} and ${file} give the same wiki page name ${page}.`);
    seen.set(key, file);
    pages.set(file, page);
  }
  return pages;
}

/** The top-level Markdown files of the docs folder, sorted. */
export function listDocs(docsDir) {
  return readdirSync(docsDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
    .map(entry => entry.name)
    .sort();
}

/** LF line endings, no byte order mark, exactly one newline at the end. */
export function normalizeText(text) {
  return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/\n*$/, '\n');
}

// ---------------------------------------------------------------------------
// Code masking: fenced code blocks and inline code spans stay byte for byte.

const fenceOpen = /^(\s*)(`{3,}|~{3,})(.*)$/;

/**
 * A copy of the text in which fenced code blocks, inline code spans and HTML
 * comments are replaced by spaces (line breaks stay), so every match on the
 * copy has the same position in the original and code never matches.
 */
export function maskCode(text) {
  const lines = text.split('\n');
  const out = [];
  let fence = null;
  for (const line of lines) {
    if (fence) {
      const close = line.match(/^\s*(`{3,}|~{3,})\s*$/);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      out.push(' '.repeat(line.length));
      continue;
    }
    const open = line.match(fenceOpen);
    // A backtick fence has no backtick in its info string.
    if (open && !(open[2][0] === '`' && open[3].includes('`'))) {
      fence = open[2];
      out.push(' '.repeat(line.length));
      continue;
    }
    out.push(line);
  }
  let masked = out.join('\n');
  masked = maskSpans(masked);
  return masked.replace(/<!--[\s\S]*?(?:-->|$)/g, match => match.replace(/[^\n]/g, ' '));
}

// Inline code: a run of n backticks up to the next run of exactly n backticks
// in the same paragraph. A run without a partner is literal text.
function maskSpans(text) {
  let result = '';
  let index = 0;
  while (index < text.length) {
    if (text[index] !== '`') { result += text[index]; index++; continue; }
    let end = index;
    while (text[end] === '`') end++;
    const length = end - index;
    const paragraphEnd = text.slice(end).search(/\n[^\S\n]*\n/);
    const limit = paragraphEnd === -1 ? text.length : end + paragraphEnd;
    let close = -1;
    for (let at = end; at < limit; at++) {
      if (text[at] !== '`') continue;
      let runEnd = at;
      while (text[runEnd] === '`') runEnd++;
      if (runEnd - at === length) { close = runEnd; break; }
      at = runEnd - 1;
    }
    if (close === -1) { result += text.slice(index, end); index = end; continue; }
    result += text.slice(index, close).replace(/[^\n]/g, ' ');
    index = close;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Link targets.

const lineOf = (text, position) => text.slice(0, position).split('\n').length;

// Encodes each path segment again after the decode of the resolution.
const encodePath = repoPath => repoPath.split('/').map(segment => encodeURIComponent(segment)).join('/');

// True when every segment of the repository path exists with this exact case,
// also on a file system that ignores case.
function existsExact(repoRoot, repoPath) {
  if (repoPath === '.' || repoPath === '') return true;
  let current = repoRoot;
  for (const segment of repoPath.split('/')) {
    let names;
    try { names = readdirSync(current); } catch { return false; }
    if (!names.includes(segment)) return false;
    current = path.join(current, segment);
  }
  return existsSync(current);
}

/**
 * Rewrites one link target of a doc for the wiki. `kind` is 'image' for a
 * Markdown image or an HTML src/srcset, otherwise 'link'. Returns the target
 * unchanged when no rule applies.
 */
export function rewriteTarget(target, kind, context, line) {
  if (target === '' || target.startsWith('#') || scheme.test(target) || target.startsWith('//')) return target;
  const { repoRoot, docsPath, file, repoUrl, branch, pages } = context;
  const hash = target.indexOf('#');
  const anchor = hash === -1 ? '' : target.slice(hash);
  let pathPart = hash === -1 ? target : target.slice(0, hash);
  const question = pathPart.indexOf('?');
  const query = question === -1 ? '' : pathPart.slice(question);
  if (question !== -1) pathPart = pathPart.slice(0, question);
  const where = `${docsPath}/${file}:${line}`;
  let decoded;
  try { decoded = decodeURIComponent(pathPart); } catch { throw new Error(`${where}: the link target ${target} has a bad percent encoding.`); }
  const repoPath = decoded.startsWith('/')
    ? path.posix.normalize(decoded.replace(/^\/+/, '') || '.')
    : path.posix.normalize(path.posix.join(docsPath, decoded));
  if (repoPath === '..' || repoPath.startsWith('../')) throw new Error(`${where}: the link target ${target} is outside the repository.`);
  const clean = repoPath.replace(/\/+$/, '') || '.';
  if (!existsExact(repoRoot, clean)) throw new Error(`${where}: the link target ${target} does not exist (${clean}).`);
  if (path.posix.dirname(clean) === docsPath) {
    const page = pages.get(path.posix.basename(clean));
    if (page !== undefined) return page + anchor;
  }
  const imagesPath = `${docsPath}/images/`;
  if (clean.startsWith(imagesPath)) return `images/${encodePath(clean.slice(imagesPath.length))}${query}${anchor}`;
  const encoded = clean === '.' ? '' : encodePath(clean);
  if (kind === 'image') return `${repoUrl}/raw/${branch}/${encoded}${query}`;
  return `${repoUrl}/blob/${branch}/${encoded}${query}${anchor}`;
}

// Finds the "[" that opens the link text which ends at the "]" at `close`.
function openingBracket(masked, close) {
  let depth = 0;
  for (let at = close; at >= 0; at--) {
    const char = masked[at];
    if (at > 0 && masked[at - 1] === '\\') continue;
    if (char === ']') depth++;
    else if (char === '[') { depth--; if (depth === 0) return at; }
    else if (char === '\n' && masked[at - 1] === '\n') return -1;
  }
  return -1;
}

// Parses an inline link destination that starts at `start` (just after "(").
// Returns { from, to } of the destination text (without "<" and ">"), or null.
function inlineDestination(masked, start) {
  let at = start;
  while (masked[at] === ' ' || masked[at] === '\t' || masked[at] === '\n') at++;
  if (masked[at] === '<') {
    const end = masked.indexOf('>', at + 1);
    if (end === -1 || masked.slice(at + 1, end).includes('\n')) return null;
    return closeOfLink(masked, end + 1) ? { from: at + 1, to: end } : null;
  }
  const from = at;
  let depth = 0;
  while (at < masked.length) {
    const char = masked[at];
    if (char === '\\') { at += 2; continue; }
    if (/\s/.test(char)) break;
    if (char === '(') depth++;
    else if (char === ')') { if (depth === 0) break; depth--; }
    at++;
  }
  if (!closeOfLink(masked, at)) return null;
  return { from, to: at };
}

// After the destination: optional white space and a title, then ")".
function closeOfLink(masked, at) {
  const rest = masked.slice(at);
  return /^[ \t\n]*(?:(?:"[^"]*"|'[^']*'|\([^)]*\))[ \t\n]*)?\)/.test(rest);
}

/**
 * Rewrites the links of one doc for the wiki: inline links and images,
 * reference definitions, and src, srcset and href attributes of raw HTML.
 * Fenced code, inline code and HTML comments stay byte for byte.
 * context: { file, docsDir, repoRoot?, repoUrl?, branch?, pages? }. `file` is
 * the doc's file name in docsDir; repoRoot defaults to docsDir/../..; pages is
 * the Map of wikiPageNames and defaults to the docs of docsDir.
 */
export function rewriteLinks(markdown, context) {
  const docsDir = path.resolve(context.docsDir);
  const repoRoot = path.resolve(context.repoRoot ?? path.join(docsDir, '..', '..'));
  const docsPath = path.relative(repoRoot, docsDir).split(path.sep).join('/');
  if (!docsPath || docsPath.startsWith('..')) throw new Error(`The docs folder ${docsDir} is not inside the repository ${repoRoot}.`);
  const full = {
    file: context.file,
    repoRoot,
    docsPath,
    repoUrl: (context.repoUrl ?? defaultRepoUrl).replace(/\/+$/, ''),
    branch: context.branch ?? defaultBranch,
    pages: context.pages ?? wikiPageNames(listDocs(docsDir)),
  };
  const masked = maskCode(markdown);
  const edits = [];
  const edit = (from, to, kind) => {
    const target = markdown.slice(from, to);
    const replaced = rewriteTarget(target, kind, full, lineOf(markdown, from));
    if (replaced !== target) edits.push({ from, to, text: replaced });
  };

  // Reference labels that an image uses: ![alt][id], ![id][] and ![id].
  const imageLabels = new Set();
  for (const match of masked.matchAll(/!\[([^\]]*)\](?:\[([^\]]*)\])?/g)) {
    const label = (match[2] || match[1]).trim().toLowerCase().replace(/\s+/g, ' ');
    if (label) imageLabels.add(label);
  }

  // Inline links and images: every "](" that closes a link text.
  for (let close = masked.indexOf(']('); close !== -1; close = masked.indexOf('](', close + 1)) {
    if (close > 0 && masked[close - 1] === '\\') continue;
    const open = openingBracket(masked, close);
    if (open === -1) continue;
    const destination = inlineDestination(masked, close + 2);
    if (!destination) continue;
    edit(destination.from, destination.to, open > 0 && masked[open - 1] === '!' ? 'image' : 'link');
  }

  // Reference definitions: [id]: target "title".
  for (const match of masked.matchAll(/^ {0,3}\[([^\]]+)\]:[ \t]*(<[^>\n]*>|\S+)/gm)) {
    const label = match[1].trim().toLowerCase().replace(/\s+/g, ' ');
    const raw = match[2];
    const start = match.index + match[0].length - raw.length;
    const [from, to] = raw.startsWith('<') ? [start + 1, start + raw.length - 1] : [start, start + raw.length];
    edit(from, to, imageLabels.has(label) ? 'image' : 'link');
  }

  // Raw HTML: src and srcset are images, href is a link.
  for (const tag of masked.matchAll(/<[A-Za-z][A-Za-z0-9-]*\b[^<>]*>/g)) {
    for (const attribute of tag[0].matchAll(/\s(src|srcset|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi)) {
      const value = attribute[2] ?? attribute[3] ?? attribute[4];
      const valueStart = tag.index + attribute.index + attribute[0].length - value.length - (attribute[4] === undefined ? 1 : 0);
      const name = attribute[1].toLowerCase();
      if (name !== 'srcset') { edit(valueStart, valueStart + value.length, name === 'src' ? 'image' : 'link'); continue; }
      // srcset: "url descriptor, url descriptor".
      for (const candidate of value.matchAll(/[^\s,][^\s]*/g)) {
        const before = value.slice(0, candidate.index);
        // Only the first token after a comma (or at the start) is a URL.
        if (!/(^|,)\s*$/.test(before)) continue;
        const url = candidate[0].replace(/,$/, '');
        edit(valueStart + candidate.index, valueStart + candidate.index + url.length, 'image');
      }
    }
  }

  edits.sort((a, b) => b.from - a.from);
  let result = markdown;
  let previous = Infinity;
  for (const { from, to, text } of edits) {
    if (to > previous) continue; // overlapping matches: the outer one stays
    result = result.slice(0, from) + text + result.slice(to);
    previous = from;
  }
  return result;
}

// ---------------------------------------------------------------------------
// The wiki tree.

/** The text of the first "# " heading outside fenced code, or null. */
export function firstHeading(markdown) {
  const masked = maskCode(markdown);
  const match = masked.match(/^# +(.*?)[ \t]*(?:#+[ \t]*)?$/m);
  if (!match) return null;
  const start = match.index + match[0].indexOf(match[1]);
  const text = markdown.slice(start, start + match[1].length).trim();
  return text || null;
}

// Link text for the page list: links become their text, and lone brackets are escaped.
const listText = heading => heading.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/(?<!\\)([[\]])/g, '\\$1');

/** The page list of Home.md and _Sidebar.md, sorted by H1 text, then by page name. */
export function pageList(pages) {
  return [...pages]
    .sort((a, b) => a.title.localeCompare(b.title, 'en', { sensitivity: 'base' }) || (a.page < b.page ? -1 : a.page > b.page ? 1 : 0))
    .map(({ title, page }) => `- [${listText(title)}](${page})`)
    .join('\n');
}

export const pageBanner = (file, { repoUrl, branch, docsPath }) =>
  `> This page is generated from [${docsPath}/${file}](${repoUrl}/blob/${branch}/${docsPath}/${file}). Change the text there. The next synchronization replaces changes that you make in the wiki.`;

export const homeBanner = ({ repoUrl, branch, docsPath }) =>
  `> This wiki is generated from the folder [${docsPath}](${repoUrl}/tree/${branch}/${docsPath}). Change the documentation there. The next synchronization replaces changes that you make in the wiki.`;

export const homeIntro = 'The documentation of Nodiverna: installation, operation, the areas of the portal and the agent contracts.';

// Every file below a folder, as sorted relative paths with "/". Links are refused.
function filesBelow(folder, prefix = '') {
  const result = [];
  for (const name of readdirSync(folder).sort()) {
    const full = path.join(folder, name), relative = prefix ? `${prefix}/${name}` : name;
    const info = lstatSync(full);
    if (info.isSymbolicLink()) throw new Error(`${full} is a symbolic link. The wiki mirror copies only files.`);
    if (info.isDirectory()) result.push(...filesBelow(full, relative));
    else if (info.isFile()) result.push(relative);
  }
  return result;
}

/**
 * Builds the wiki in memory and writes it into outDir. outDir must be missing
 * or empty; nothing is written when a doc has an error.
 * @returns {{ pages: { file: string, page: string, title: string }[], files: string[] }}
 */
export function buildWiki({ docsDir, outDir, repoUrl = defaultRepoUrl, branch = defaultBranch, repoRoot }) {
  const docs = path.resolve(docsDir);
  const root = path.resolve(repoRoot ?? path.join(docs, '..', '..'));
  const docsPath = path.relative(root, docs).split(path.sep).join('/');
  const url = repoUrl.replace(/\/+$/, '');
  const settings = { repoUrl: url, branch, docsPath };
  if (existsSync(outDir)) {
    if (!statSync(outDir).isDirectory() || readdirSync(outDir).length > 0) throw new Error(`The output folder ${outDir} exists and is not empty.`);
  }

  const names = wikiPageNames(listDocs(docs));
  const output = new Map();
  const pages = [];
  for (const [file, page] of names) {
    const source = normalizeText(readFileSync(path.join(docs, file), 'utf8'));
    const body = rewriteLinks(source, { file, docsDir: docs, repoRoot: root, repoUrl: url, branch, pages: names });
    output.set(`${page}.md`, normalizeText(`${pageBanner(file, settings)}\n\n${body}`));
    pages.push({ file, page, title: firstHeading(source) ?? page });
  }
  const list = pageList(pages);
  output.set('Home.md', normalizeText(`${homeBanner(settings)}\n\n${homeIntro}\n\n## Pages\n\n${list}\n`));
  output.set('_Sidebar.md', normalizeText(`**[Home](Home)**\n\n${list}\n`));

  const imagesDir = path.join(docs, 'images');
  const images = existsSync(imagesDir) ? filesBelow(imagesDir) : [];

  mkdirSync(outDir, { recursive: true });
  for (const [name, text] of output) writeFileSync(path.join(outDir, name), text);
  for (const image of images) {
    const target = path.join(outDir, 'images', ...image.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(imagesDir, ...image.split('/')), target);
  }
  return { pages, files: [...output.keys(), ...images.map(image => `images/${image}`)].sort() };
}

// ---------------------------------------------------------------------------
// CLI.

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const { values } = parseArgs({ options: { out: { type: 'string' } }, strict: true });
    if (!values.out) throw new Error('Usage: node scripts/wiki-mirror.mjs --out <dir>');
    const serverDesk = fileURLToPath(new URL('../', import.meta.url));
    const outDir = path.resolve(values.out);
    const { pages, files } = buildWiki({ docsDir: path.join(serverDesk, 'docs'), outDir });
    console.log(`Wrote ${pages.length} wiki pages and ${files.length} files to ${outDir}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
