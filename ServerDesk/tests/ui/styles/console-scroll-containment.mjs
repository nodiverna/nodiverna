// The console frame never scrolls as a document: absolutely positioned content deep in
// the workspace (sr-only text, hidden .sdx-choice inputs) must not hang off the initial containing
// block, extend the document below the job dock and let a fast wheel scroll slide the whole frame
// up. Each guard of the fix in ui/styles/console.css has one assertion here; the browser check
// is expectFixedFrame in e2e/smoke.spec.ts.
import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync(new URL('../../../ui/styles/console.css', import.meta.url), 'utf8');
const globals = fs.readFileSync(new URL('../../../app/globals.css', import.meta.url), 'utf8');
let checks = 0;
const ok = (value, label) => { assert.ok(value, label); checks++; };

/** Top-level rules as [selector, body, comment directly above]. Media blocks are skipped. */
function rules(source) {
  const out = [];
  const pattern = /(\/\*[\s\S]*?\*\/\s*)?([^{}@/\s][^{}]*?)\{([^{}]*)\}/g;
  let depth = 0, last = 0;
  for (let match; (match = pattern.exec(source));) {
    // Track @media nesting between the previous match and this one.
    const between = source.slice(last, match.index);
    depth += (between.match(/@[^{]*\{/g) ?? []).length;
    depth -= (between.match(/^\s*\}/gm) ?? []).length;
    last = pattern.lastIndex;
    out.push({selector: match[2].trim(), body: match[3], comment: match[1] ?? '', nested: depth > 0});
  }
  return out;
}
const declarations = body => Object.fromEntries(body.replace(/\/\*[\s\S]*?\*\//g, '').split(';').map(part => part.split(':')).filter(pair => pair.length >= 2).map(([name, ...value]) => [name.trim(), value.join(':').trim()]));
const rule = (source, selector) => rules(source).find(entry => !entry.nested && entry.selector === selector);

// Guard 1: the frame is positioned and clips without being a scroll container.
const frame = rule(css, '.sdx');
ok(frame, 'the .sdx frame rule exists');
const frameDecl = declarations(frame.body);
ok(frameDecl.position === 'relative', '.sdx is positioned, so absolute descendants have it in their containing-block chain');
ok(frameDecl.overflow === 'clip', '.sdx clips with overflow: clip, so scrollIntoView() and focus() cannot scroll it');
ok(!/overflow\s*:\s*hidden/.test(frame.body.replace(/\/\*[\s\S]*?\*\//g, '')), '.sdx is no overflow: hidden scroll container');
ok(/absolutely positioned descendants/i.test(frame.body) && /scrollIntoView/.test(frame.body), 'the .sdx comment states why the frame is positioned and clips');

// Guard 2: the workspace is the positioned page scroller.
const main = rule(css, '.sdx-main');
ok(main, 'the .sdx-main rule exists');
const mainDecl = declarations(main.body);
ok(mainDecl.position === 'relative', '.sdx-main is positioned, so absolute content scrolls and clips with the workspace');
ok(mainDecl['overflow-y'] === 'auto', '.sdx-main stays the only page scroller');
ok(/absolutely positioned content/i.test(main.comment) && /extending the document/i.test(main.comment), 'the .sdx-main comment states why it is positioned');

// Guard 3: while the console is mounted, the root and body do not scroll or chain overscroll.
// The console marks the root with data-ui="redesign" while it is mounted (ui/shell/console.tsx); html:has(.sdx)
// would restyle the whole document on every layer that opens or closes.
const root = rules(css).find(entry => !entry.nested && /html\[data-ui="redesign"\]/.test(entry.selector) && /overflow/.test(entry.body));
ok(root, 'a root rule is scoped to the mounted console');
ok(root.selector.split(',').map(part => part.trim()).includes('html[data-ui="redesign"] body'), 'the scoped rule also covers body');
ok(/root\.dataset\.ui='redesign'/.test(fs.readFileSync(new URL('../../../ui/shell/console.tsx', import.meta.url), 'utf8')), 'the console sets data-ui="redesign" on the root while it is mounted');
ok(!/html:has\(/.test(css.replace(/\/\*[\s\S]*?\*\//g, '')), 'no :has() on the root: a layer that opens or closes would restyle the whole document');
const rootDecl = declarations(root.body);
ok(rootDecl.overflow === 'hidden', 'the root does not scroll while the console is mounted');
ok(rootDecl['overscroll-behavior'] === 'none', 'overscroll does not chain to the root');
ok(/never scrolls/i.test(root.comment) && /sign-in/i.test(root.comment), 'the root rule comment states why it exists and what keeps scrolling');

// Pages without the console keep their document scrolling: no bare html/body overflow lock.
for (const [name, source] of [['console.css', css], ['globals.css', globals]]) {
  for (const entry of rules(source)) {
    const bare = entry.selector.split(',').map(part => part.trim()).some(part => /^(html|body|:root)$/.test(part) || /^html\s+body$/.test(part));
    ok(!(bare && /overflow(-[xy])?\s*:\s*(hidden|clip)/.test(entry.body)), `${name}: no rule locks the overflow of a bare html or body selector (${entry.selector})`);
  }
}

console.log(`console-scroll-containment: ${checks} checks passed.`);
