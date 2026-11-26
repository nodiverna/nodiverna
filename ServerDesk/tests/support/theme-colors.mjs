// Color helpers for the theme token and light island tests.
//
//   resolveTokens(css, mode, scheme?)  -> Map of every custom property in the
//     `:root` blocks of a stylesheet to its computed color text, with var(),
//     light-dark() (picked by mode: 'light' | 'dark'), color-mix(in srgb, …),
//     hex and rgb()/rgba() resolved. Non-color values stay as substituted text.
//     With a scheme choice {light, dark}, the matching scheme blocks
//     (:root[data-scheme-light="…"], :root[data-scheme-dark="…"]) apply on top.
//   schemeBlocks(css) -> [{selector, mode, id, swatch, decls}] of every rule that
//     names data-scheme-light / data-scheme-dark.
//   resolveColor(text, tokens, mode) -> {r,g,b,a} (0–255, alpha 0–1) or null.
//   contrast(a, b) -> WCAG 2 contrast ratio of two opaque colors.
//   colorLiterals(text) -> hex and rgb/rgba/hsl/hsla literals in CSS text.
import {createRequire} from 'node:module';
import path from 'node:path';

const require = createRequire(path.join(process.cwd(), 'package.json'));
export const postcss = createRequire(require.resolve('next/package.json'))('postcss');

const literalPattern = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(/gi;
/** Color literals (hex, rgb(), rgba(), hsl(), hsla()) in CSS text; comments are ignored. */
export function colorLiterals(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').match(literalPattern) ?? [];
}

/** Splits at top-level commas (not inside parentheses). */
function splitArgs(text) {
  const parts = [];
  let depth = 0, start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) { parts.push(text.slice(start, i).trim()); start = i + 1; }
  }
  parts.push(text.slice(start).trim());
  return parts;
}

/** Finds `name(` … matching `)` and returns [start, end, inner] for the first occurrence. */
function findCall(text, name) {
  const at = text.search(new RegExp(`(?<![\\w-])${name}\\(`));
  if (at < 0) return null;
  const open = at + name.length;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return [at, i + 1, text.slice(open + 1, i)];
  }
  throw new Error(`Unbalanced ${name}() in ${text}`);
}

function parseHex(hex) {
  let h = hex.slice(1);
  if (h.length === 3 || h.length === 4) h = [...h].map(c => c + c).join('');
  if (h.length !== 6 && h.length !== 8) return null;
  const n = i => parseInt(h.slice(i, i + 2), 16);
  return {r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1};
}

const named = {transparent: {r: 0, g: 0, b: 0, a: 0}, white: {r: 255, g: 255, b: 255, a: 1}, black: {r: 0, g: 0, b: 0, a: 1}};

/** Parses one already substituted color (no var(), no light-dark()). */
function parseColor(text) {
  const t = text.trim().toLowerCase();
  if (named[t]) return {...named[t]};
  if (t.startsWith('#')) return parseHex(t);
  const rgb = t.match(/^rgba?\(([^)]*)\)$/);
  if (rgb) {
    const parts = rgb[1].split(/[\s,/]+/).filter(Boolean).map(part => part.endsWith('%') ? parseFloat(part) / 100 * (rgb[1].includes('%') ? 255 : 1) : parseFloat(part));
    return {r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1};
  }
  const mix = findCall(t, 'color-mix');
  if (mix && mix[0] === 0 && mix[1] === t.length) return mixColors(mix[2]);
  return null;
}

/** color-mix(in srgb, A p%, B q%) with premultiplied alpha, as in CSS Color 5. */
function mixColors(inner) {
  const [space, first, second] = splitArgs(inner);
  if (space !== 'in srgb') throw new Error(`Only "in srgb" is supported: ${inner}`);
  const part = text => {
    const m = text.match(/^(.*?)(?:\s+([\d.]+)%)?$/s);
    const color = parseColor(m[1]);
    if (!color) throw new Error(`Not a color in color-mix: ${text}`);
    return {color, p: m[2] === undefined ? null : parseFloat(m[2]) / 100};
  };
  const a = part(first), b = part(second);
  let p1 = a.p, p2 = b.p;
  if (p1 === null && p2 === null) { p1 = .5; p2 = .5; }
  else if (p1 === null) p1 = 1 - p2;
  else if (p2 === null) p2 = 1 - p1;
  const sum = p1 + p2, scale = Math.min(sum, 1);
  p1 /= sum; p2 /= sum;
  const alpha = a.color.a * p1 + b.color.a * p2;
  const channel = key => alpha === 0 ? 0 : (a.color[key] * a.color.a * p1 + b.color[key] * b.color.a * p2) / alpha;
  return {r: channel('r'), g: channel('g'), b: channel('b'), a: alpha * scale};
}

/** Picks the light or dark argument of every light-dark() (innermost first). */
export function pickMode(text, mode) {
  let out = text, call;
  while ((call = findCall(out, 'light-dark'))) {
    const [light, dark] = splitArgs(call[2]);
    out = out.slice(0, call[0]) + (mode === 'dark' ? dark : light) + out.slice(call[1]);
  }
  return out;
}

/** Replaces var(--x) (with optional fallback) from `tokens`, recursively. */
export function substitute(text, tokens, seen = []) {
  let out = text, call;
  while ((call = findCall(out, 'var'))) {
    const [name, fallback] = splitArgs(call[2]);
    if (seen.includes(name)) throw new Error(`Cycle: ${[...seen, name].join(' -> ')}`);
    const raw = tokens.has(name) ? tokens.get(name) : fallback;
    if (raw === undefined) throw new Error(`Unknown token ${name}`);
    out = out.slice(0, call[0]) + substitute(raw, tokens, [...seen, name]) + out.slice(call[1]);
  }
  return out;
}

/** Resolves a color expression to {r,g,b,a} or null if it is not a color. */
export function resolveColor(text, tokens, mode) {
  return parseColor(pickMode(substitute(text, tokens), mode));
}

/** Raw declarations of every custom property in the stylesheet's `:root` rules (top level only). */
export function rootTokens(css) {
  const raw = new Map();
  postcss.parse(css).each(node => {
    if (node.type === 'rule' && node.selector.trim() === ':root') node.walkDecls(/^--/, decl => { raw.set(decl.prop, decl.value); });
  });
  return raw;
}

const schemeSelector = /^:root\[data-scheme-(light|dark)="([a-z-]+)"\]$/;
/** Rules that name a scheme attribute, with the mode and id of their :root part and their declarations. */
export function schemeBlocks(css) {
  const blocks = [];
  postcss.parse(css).walkRules(rule => {
    if (!/data-scheme-(?:light|dark)/.test(rule.selector)) return;
    const parts = rule.selectors.map(part => part.trim());
    const match = parts.map(part => part.match(schemeSelector)).find(Boolean);
    const decls = new Map();
    rule.walkDecls(decl => { decls.set(decl.prop, decl.value); });
    blocks.push({selector: parts.join(', '), parts, mode: match?.[1], id: match?.[2], swatch: parts.find(part => part.startsWith('[data-scheme-swatch')), decls, parent: rule.parent.type});
  });
  return blocks;
}

/** Every token of the stylesheet resolved for a mode: color tokens as {r,g,b,a}, others as text. */
export function resolveTokens(css, mode, scheme) {
  const raw = rootTokens(css), out = new Map();
  if (scheme) for (const block of schemeBlocks(css)) if (block.mode && scheme[block.mode] === block.id) for (const [name, value] of block.decls) raw.set(name, value);
  for (const name of raw.keys()) {
    const text = pickMode(substitute(raw.get(name), raw), mode);
    out.set(name, parseColor(text) ?? text);
  }
  return out;
}

const hex2 = n => Math.round(n).toString(16).padStart(2, '0');
/** #rrggbb (or #rrggbbaa if translucent) of a resolved color. */
export function toHex(color) {
  return `#${hex2(color.r)}${hex2(color.g)}${hex2(color.b)}${color.a < 1 ? hex2(color.a * 255) : ''}`;
}

function luminance({r, g, b}) {
  const lin = v => { const c = v / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; };
  return .2126 * lin(r) + .7152 * lin(g) + .0722 * lin(b);
}

/** Composites a translucent color over an opaque one. */
export function over(top, bottom) {
  const a = top.a;
  return {r: top.r * a + bottom.r * (1 - a), g: top.g * a + bottom.g * (1 - a), b: top.b * a + bottom.b * (1 - a), a: 1};
}

/** WCAG 2 contrast ratio. */
export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + .05) / (y + .05);
}
