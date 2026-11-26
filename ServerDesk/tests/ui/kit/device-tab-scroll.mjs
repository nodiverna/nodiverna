// The kit Tabs strip (ui/kit/tabs.tsx, the device area bar among others) scrolls sideways on
// narrow screens; the active tab must be fully visible, and so must a tab that receives keyboard
// focus. revealScrollLeft computes the strip's new scrollLeft from the tab's geometry, whether the
// tab is active or only focused; tabs.tsx applies it. device.tsx has no reveal effect of its own.
import fs from 'node:fs';
import assert from 'node:assert/strict';
const {revealScrollLeft}=await import('../../../ui/kit/tab-reveal.ts');
let checks=0;

// 390px strip with 12px side padding.
const strip=(scrollLeft,clientWidth=390)=>({scrollLeft,clientWidth});
const tab=(offsetLeft,offsetWidth)=>({offsetLeft,offsetWidth});

// A fully visible tab: nothing moves.
assert.equal(revealScrollLeft(strip(0),tab(12,90),12),null,'first tab, unscrolled');
assert.equal(revealScrollLeft(strip(200),tab(300,90),12),null,'tab inside the scrolled view');
assert.equal(revealScrollLeft(strip(0),tab(288,90),12),null,'tab ends exactly at the padding edge');
assert.equal(revealScrollLeft(strip(0,1440),tab(800,110),28),null,'desktop: every tab visible, nothing moves');
checks+=4;

// Past the right edge: offsetLeft+offsetWidth+padding-clientWidth.
assert.equal(revealScrollLeft(strip(0),tab(620,110),12),620+110+12-390);
assert.equal(revealScrollLeft(strip(0),tab(300,90),12),300+90+12-390,'partly cut at the right edge');
assert.equal(revealScrollLeft(strip(0,1000),tab(980,120),28),980+120+28-1000,'wider strip, desktop padding');
checks+=3;

// Before the left edge: offsetLeft-padding, never below 0.
assert.equal(revealScrollLeft(strip(400),tab(200,90),12),188);
assert.equal(revealScrollLeft(strip(400),tab(395,90),12),383,'partly hidden under the left padding');
assert.equal(revealScrollLeft(strip(300),tab(8,90),12),0,'never below 0');
checks+=3;

// A tab wider than the strip's visible area aligns its left edge.
assert.equal(revealScrollLeft(strip(0,200),tab(300,250),12),288);
assert.equal(revealScrollLeft(strip(500,200),tab(300,250),12),288,'also from the right');
assert.equal(revealScrollLeft(strip(288,200),tab(300,250),12),null,'already aligned: nothing moves');
checks+=3;

// Sub-pixel differences are no reason to move.
assert.equal(revealScrollLeft(strip(0),tab(288.4,90),12),null);
checks++;

// A focused tab that is not the active one is revealed the same way: the active Overview sits at the
// start, the keyboard moves the focus to History far right.
assert.equal(revealScrollLeft(strip(0),tab(700,96),12),700+96+12-390,'a focused, not active tab at the right edge');
checks++;

// tabs.tsx: imports the function, sets only the strip's scrollLeft, honours reduced motion, reveals the
// active tab on mount, value change and resize and a tab on focus. device.tsx keeps no effect of its own.
{
 const source=fs.readFileSync('ui/kit/tabs.tsx','utf8');
 assert.match(source,/import \{[^}]*revealScrollLeft[^}]*\} from '@\/ui\/kit\/tab-reveal';/);
 const reveal=source.slice(source.indexOf('const reveal=useCallback('),source.indexOf('},[base,overflow]);'));
 assert.ok(reveal.length>0,'one reveal function');
 assert.match(reveal,/revealScrollLeft\(/);
 assert.match(reveal,/prefers-reduced-motion: reduce/);
 assert.match(reveal,/list\.scrollTo\(\{left:next,behavior:instant\|\|reduce\?'instant':'smooth'\}\)/,'instant first, then smooth unless reduced motion');
 assert.match(source,/const first=!placed\.current;placed\.current=true;\s*reveal\(value,first\);\s*\},\[value,itemsKey,reveal\]\);/,'the active tab on mount and on every value change');
 assert.match(source,/new ResizeObserver\(\(\)=>\{measureScroll\(\);reveal\(valueRef\.current,true\);\}\)/,'and again when the strip resizes');
 assert.match(source,/onFocus:\(\)=>reveal\(item\.id,false\)/,'a focused tab is revealed');
 assert.ok(!source.includes('.scrollIntoView('),'no scrollIntoView: the page must not scroll vertically');
 assert.doesNotMatch(reveal,/\.focus\(|location|history\./,'focus and URL stay');
 const device=fs.readFileSync('ui/devices/device/device.tsx','utf8');
 assert.doesNotMatch(device,/revealScrollLeft|tabStrip|scrollTo\(/,'device.tsx has no reveal effect of its own');
 assert.match(device,/<Tabs items=\{areaTabs\}/,'the device area bar is the kit Tabs');
 const revealSource=fs.readFileSync('ui/kit/tab-reveal.ts','utf8');
 assert.doesNotMatch(revealSource,/from 'react'|document|window/,'the module is pure');
 checks+=13;
}

console.log(`PASS device tab scroll (${checks} checks): the active device tab is revealed inside the strip's padding, only by its own scrollLeft, also on keyboard focus.`);
