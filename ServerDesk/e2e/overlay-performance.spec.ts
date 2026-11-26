// Frame budget of the console workspace, the command palette and Help. Only the project perf runs this file, and it
// exists only with E2E_PERF=1:
//   E2E_PERF=1 BASE_URL=https://localhost:<port> pnpm test:e2e --project perf
//
// The budget, held in every scenario below at both viewports:
//   (a) no long animation frame over 50 ms (PerformanceObserver type long-animation-frame) in the measured window:
//       from the trigger until the open or close animation ends, during a 3 s list scroll, during 3 s of clock ticks,
//       and from a data refresh until its render is done;
//   (c) every key press in a window (Ctrl K, typed characters, ↓, Esc, F1) has an Event Timing duration (input to next
//       paint) of 100 ms or less.
//   (d) in the four refresh scenarios (console-refresh-*), no main-thread parse of 50 ms or more: worstMainParseMs, the
//       longest call of Response.prototype.json, Response.prototype.text or JSON.parse on the main thread in the window,
//       is 50 ms or less. The console parses and diffs its answer in a worker (ui/shell/console-payload.worker.ts), so
//       the field is 0 there; a refresh that falls back to the main thread shows the parse of the ~4 MB answer here.
// (b), the share of requestAnimationFrame intervals of 25 ms or less during the open animation and the scroll (at
// least 90 %), is still measured and written to the JSON line, but it does not fail the run (human decision Q84).
// 50 ms is the Long Animation Frames threshold, 25 ms is 1.5 frames at 60 Hz, 100 ms is half the INP "good" limit.
//
// Scenarios, each at 1440×900 (no CPU throttling) and at 390×844 (touch, 4× CPU throttling through CDP
// Emulation.setCPUThrottlingRate): open the palette with Ctrl K and with the top-bar search; type "srv" one key at a
// time; scroll the result list for 3 s (wheel on the desktop, touch drag at 390 px); move the selection 20 rows with ↓;
// close with Esc; open Help with F1 and with the top-bar help button; scroll the Help body for 3 s; close Help with
// Esc and with its close button. The console's 1 s clock runs all the time (no fake timers). The workspace scenarios:
//   console-idle-reference      3 s of clock ticks with no overlay open;
//   console-refresh-unchanged   a data refresh (the serverdesk:refresh event) whose answer equals the previous one;
//   console-refresh-heartbeat   a data refresh whose answer has every device's lastSeen advanced and its CPU and RAM
//                               changed (the realistic 30 s refresh), with no overlay, with Help open (-help) and with
//                               the palette open (-palette).
//   console-first-load          after the scenarios above, a page reload at the same viewport and throttling: the time
//                               from the start of the console's /api/console fetch to the first fleet row, with the long
//                               frames and the main-thread parse in between. Measured and written only, never gated.
//
// The data: 250 devices, cloned from the sample devices of ui/shell/demo.ts with unique ids, names and addresses, in 12
// groups, served through route interception of GET /api/console (the rest of the answer is the installation's own).
// The palette then lists at least 280 items. The same interception serves both refresh answers: the unchanged one and
// a heartbeat answer (every lastSeen at the time of the request, CPU and RAM moved). No product code path, flag or
// setting exists for this.
//
// The close windows (palette-close-esc, help-close-esc) stay open until the overlay's DOM is gone (no .sd-palette, no
// .sdx-drawer-nonmodal left in the document), so teardown work that runs after the first paint counts in the window.
// The open and close windows let the frame of their key press paint before they query a locator (nextPaint).
//
// Output: one JSON line per scenario and viewport in e2e/artifacts/perf/overlay-performance.jsonl and on stdout:
// the worst long animation frame (ms), the 90th percentile of the rAF intervals (ms), the share of intervals of
// 25 ms or less, the worst keystroke duration (ms), and worstMainParseMs: the longest main-thread call of
// Response.prototype.json, Response.prototype.text or JSON.parse in the window (0 when no call took 5 ms or more). A
// test-only init script (parseRecorder, next to recorder) records those calls; the worker's own parse is not on the
// main thread and not recorded. Two breakdowns say where the time went:
//   worstKeystroke  the worst key event's name and its Event Timing phases: inputDelayMs (processingStart − startTime),
//                   processingMs (processingEnd − processingStart, the event handlers) and presentationMs (the rest of
//                   the duration: rendering until the next paint);
//   worstFrame      the worst long animation frame's script, render and style/layout time, its top scripts, and
//                   forcedStyleLayoutMs, the forced style and layout of all its scripts;
//   mostScriptMs    the largest script time of one long animation frame in the window (any frame, not only the worst).
// The path changes no data.
// With E2E_PERF_TRACE=<name>, the console-refresh-unchanged and console-refresh-heartbeat windows at 390 px (4×) are
// also recorded as CDP performance traces (Tracing, devtools.timeline) in e2e/artifacts/perf/<name>-unchanged.json and
// <name>-heartbeat.json, to see which thread did the work; tracing slows those windows, so their JSON lines are no
// measurement then.
import {execFileSync} from 'node:child_process';
import {appendFileSync, mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import type {CDPSession, Page} from '@playwright/test';
import type {DeviceGroup, Server} from '../lib/types';
import {translate} from '../lib/i18n/translate';
import {closeUsageNoticeAfter, expect, expectFleet, fillSecret, test} from './support/fixtures';
import {artifactsDir, requireOwner, writeOwner} from './support/owner';
import {nextTotp} from './support/totp';

const budget = {longFrameMs: 50, intervalMs: 25, intervalShare: 0.9, keystrokeMs: 100, mainParseMs: 50};
const resultFile = path.join(artifactsDir, 'perf', 'overlay-performance.jsonl');
const scrollMs = 3000;

/**
 * The sample devices of ui/shell/demo.ts. It imports JSON files the way the bundler does (without an import attribute),
 * which Playwright's loader rejects, so a Node process with the test loader of tests/support/register.mjs reads them.
 */
function sampleDevices(): Server[] {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const loader = pathToFileURL(path.join(root, 'tests', 'support', 'register.mjs')).href;
  const script = "const {demoData}=await import('./ui/shell/demo.ts');process.stdout.write(JSON.stringify(demoData().servers));";
  return JSON.parse(execFileSync(process.execPath, ['--import', loader, '--input-type=module', '-e', script], {cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024})) as Server[];
}

/** 250 devices in 12 groups from the four sample devices: unique ids, names, host names and addresses. */
function fleet(): {servers: Server[]; deviceGroups: DeviceGroup[]} {
  const samples = sampleDevices();
  const deviceGroups: DeviceGroup[] = Array.from({length: 12}, (_, index) => ({
    id: `perf-group-${index + 1}`, name: `Standort ${String(index + 1).padStart(2, '0')}`, description: '', parentId: null, depth: 0,
    deviceCount: 0, permissions: [],
  }));
  const servers = Array.from({length: 250}, (_, index): Server => {
    const sample = samples[index % samples.length];
    const group = deviceGroups[index % deviceGroups.length];
    group.deviceCount++;
    const number = String(index + 1).padStart(3, '0');
    const name = `${sample.name}-${number}`;
    const address = `10.20.${Math.floor(index / 200)}.${(index % 200) + 1}`;
    const snapshot = sample.snapshot ? {...sample.snapshot, hostname: name, networks: sample.snapshot.networks.map(network => ({...network, addresses: [address]}))} : null;
    return {...sample, id: `perf-${number}`, name, snapshot, groupId: group.id, groupName: group.name, groups: [{id: group.id, name: group.name}]} as Server;
  });
  return {servers, deviceGroups};
}

/** Records every rAF timestamp, every long animation frame and every Event Timing entry of the page. */
function recorder(): void {
  type Frame = {start: number; duration: number; scriptMs: number; renderMs: number; styleLayoutMs: number; forcedStyleLayoutMs: number; scripts: string[]};
  type Event = {name: string; start: number; duration: number; processingStart: number; processingEnd: number};
  const state = {raf: [] as number[], frames: [] as Frame[], events: [] as Event[]};
  (window as unknown as {__perf: typeof state}).__perf = state;
  const tick = (time: number) => {
    state.raf.push(time);
    if (state.raf.length > 20000) state.raf.splice(0, 10000);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  new PerformanceObserver(list => {
    for (const entry of list.getEntries()) {
      // Where the frame's time went: scripts (with their invokers), and the rendering phase (style, layout, paint).
      const frame = entry as PerformanceEntry & {renderStart: number; styleAndLayoutStart: number; scripts: {invoker: string; sourceFunctionName: string; duration: number; forcedStyleAndLayoutDuration: number}[]};
      const end = frame.startTime + frame.duration;
      const scripts = [...frame.scripts].sort((a, b) => b.duration - a.duration).slice(0, 3)
        .map(script => `${script.invoker}${script.sourceFunctionName ? ' ' + script.sourceFunctionName : ''} ${Math.round(script.duration)}ms${script.forcedStyleAndLayoutDuration ? ` (forced layout ${Math.round(script.forcedStyleAndLayoutDuration)}ms)` : ''}`);
      state.frames.push({
        start: frame.startTime, duration: frame.duration, scriptMs: Math.round(frame.scripts.reduce((sum, script) => sum + script.duration, 0)),
        renderMs: frame.renderStart ? Math.round(end - frame.renderStart) : 0, styleLayoutMs: frame.styleAndLayoutStart ? Math.round(end - frame.styleAndLayoutStart) : 0,
        forcedStyleLayoutMs: Math.round(frame.scripts.reduce((sum, script) => sum + script.forcedStyleAndLayoutDuration, 0)), scripts,
      });
    }
  }).observe({type: 'long-animation-frame', buffered: true});
  new PerformanceObserver(list => {
    for (const entry of list.getEntries()) {
      const event = entry as PerformanceEventTiming;
      state.events.push({name: event.name, start: event.startTime, duration: event.duration, processingStart: event.processingStart, processingEnd: event.processingEnd});
    }
  }).observe({type: 'event', buffered: true, durationThreshold: 16} as PerformanceObserverInit);
}

/**
 * Records every main-thread call of Response.prototype.json, Response.prototype.text and JSON.parse that takes 5 ms or
 * more (test-only, an init script of the page; workers keep their own, unwrapped functions). json() and text() read the
 * body as bytes first and time the decode (and the parse), the work they do on the main thread once the body is in;
 * the time spent waiting for the network is no main-thread work.
 */
function parseRecorder(): void {
  type Call = {name: string; start: number; duration: number};
  const calls: Call[] = [];
  (window as unknown as {__parse: Call[]}).__parse = calls;
  const parse = JSON.parse, decode = (bytes: ArrayBuffer) => new TextDecoder().decode(bytes);
  const timed = <T>(name: string, work: () => T): T => {
    const start = performance.now();
    try { return work(); } finally {
      const duration = performance.now() - start;
      if (duration >= 5) calls.push({name, start, duration});
    }
  };
  JSON.parse = function (this: JSON, text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) {
    return timed('JSON.parse', () => parse.call(JSON, text, reviver));
  } as typeof JSON.parse;
  const arrayBuffer = Response.prototype.arrayBuffer;
  Response.prototype.json = async function (this: Response) {
    const bytes = await arrayBuffer.call(this);
    return timed('Response.json', () => parse.call(JSON, decode(bytes)));
  };
  Response.prototype.text = async function (this: Response) {
    const bytes = await arrayBuffer.call(this);
    return timed('Response.text', () => decode(bytes));
  };
}

/** Records the start of the console's first /api/console fetch and the moment its first fleet row or card is in the DOM. */
function firstLoadRecorder(): void {
  const state = {fetchAt: 0, rowAt: 0};
  (window as unknown as {__firstLoad: typeof state}).__firstLoad = state;
  const fetch = window.fetch;
  window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (!state.fetchAt && url.pathname === '/api/console' && !url.searchParams.has('jobsOnly')) state.fetchAt = performance.now();
    return fetch.call(window, input, init);
  };
  const observer = new MutationObserver(() => {
    if (state.rowAt || !document.querySelector('.sdx-fleet .sdx-device-cell, .sdx-fleet .sdx-device-card')) return;
    state.rowAt = performance.now();
    observer.disconnect();
  });
  observer.observe(document, {childList: true, subtree: true});
}

/** console-first-load: reloads the console and writes the time from its fetch start to the first fleet row (not gated). */
async function firstLoad(page: Page, viewport: string): Promise<void> {
  const close = closeUsageNoticeAfter(page);
  await page.reload();
  await expect(page.locator('.sdx-fleet .sdx-device-cell, .sdx-fleet .sdx-device-card').first()).toBeVisible();
  await close();
  await page.waitForTimeout(1500);
  const numbers = await page.evaluate(() => {
    const load = (window as unknown as {__firstLoad: {fetchAt: number; rowAt: number}}).__firstLoad;
    const perf = (window as unknown as {__perf: {frames: {start: number; duration: number}[]}}).__perf;
    const parses = (window as unknown as {__parse: {name: string; start: number; duration: number}[]}).__parse;
    const inside = (start: number, duration: number) => start < load.rowAt && start + duration > load.fetchAt;
    const frames = perf.frames.filter(frame => inside(frame.start, frame.duration)).map(frame => frame.duration);
    const parse = parses.filter(call => inside(call.start, call.duration)).sort((a, b) => b.duration - a.duration)[0] ?? null;
    return {firstRowMs: load.rowAt - load.fetchAt, frames, parse};
  });
  const line = {
    scenario: 'console-first-load', viewport, firstRowMs: Math.round(numbers.firstRowMs),
    worstLongFrameMs: Math.round(Math.max(0, ...numbers.frames)), longFrames: numbers.frames.length, longFrameTotalMs: Math.round(numbers.frames.reduce((sum, value) => sum + value, 0)),
    worstMainParseMs: numbers.parse ? Math.round(numbers.parse.duration) : 0, worstMainParse: numbers.parse?.name ?? null,
  };
  mkdirSync(path.dirname(resultFile), {recursive: true});
  appendFileSync(resultFile, JSON.stringify(line) + '\n');
  console.log('perf ' + JSON.stringify(line));
}

type Measure = {scenario: string; frames?: boolean; intervals?: boolean; keys?: boolean; parse?: boolean};

const now = (page: Page) => page.evaluate(() => performance.now());

/** Waits until the overlay layers have no running finite animation (open and close animations, not the live dots). */
async function animationsDone(page: Page): Promise<void> {
  await page.waitForFunction(() => document.getAnimations().every(animation => {
    const target = (animation.effect as KeyframeEffect | null)?.target;
    const layer = target instanceof Element && !!target.closest('.sdx-layer');
    return !layer || animation.playState !== 'running';
  }));
  // One more frame, so the last animated frame is inside the window.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

/**
 * Waits until the two frames after the last input are painted (two rAFs, then a task after them): the key down's frame
 * and the frame of its key up, which often waits for the first. The open and close windows call it right after their
 * key press, before a locator query: a role query with a name (getByRole) computes accessible names over the whole
 * document, a DevTools task of about 20 ms at 1× and 75 ms at 4× in the renderer's main thread. Run before those frames,
 * it delayed them and counted as presentation delay of the key press, though no user input waits for it.
 */
async function nextPaint(page: Page): Promise<void> {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)))));
}

/** Waits until no element of the selector is left in the document: a closed overlay's DOM, including teardown that runs after its first paint. */
async function goneFromDocument(page: Page, selector: string): Promise<void> {
  await page.waitForFunction(selector => !document.querySelector(selector), selector);
}

/** Runs action as one measured window and reports its numbers against the budget. */
async function measure(page: Page, viewport: string, failures: string[], what: Measure, action: () => Promise<void>): Promise<void> {
  const from = await now(page);
  await action();
  const to = await now(page);
  // Long animation frames and event entries arrive after their frame.
  await page.waitForTimeout(150);
  const numbers = await page.evaluate(({from, to}) => {
    type Frame = {start: number; duration: number; scriptMs: number; renderMs: number; styleLayoutMs: number; forcedStyleLayoutMs: number; scripts: string[]};
    type Event = {name: string; start: number; duration: number; processingStart: number; processingEnd: number};
    const perf = (window as unknown as {__perf: {raf: number[]; frames: Frame[]; events: Event[]}}).__perf;
    const long = perf.frames.filter(frame => frame.start < to && frame.start + frame.duration > from);
    const frames = long.map(frame => frame.duration);
    const worst = [...long].sort((a, b) => b.duration - a.duration)[0] ?? null;
    const stamps = perf.raf.filter(time => time >= from && time <= to);
    const intervals = stamps.slice(1).map((time, index) => time - stamps[index]);
    const keyEvents = perf.events.filter(event => event.start >= from && event.start <= to && /^(?:key|beforeinput$|input$)/.test(event.name));
    const keys = keyEvents.map(event => event.duration);
    const slowest = [...keyEvents].sort((a, b) => b.duration - a.duration)[0] ?? null;
    const worstKey = slowest && {
      event: slowest.name, inputDelayMs: Math.round(slowest.processingStart - slowest.start), processingMs: Math.round(slowest.processingEnd - slowest.processingStart),
      presentationMs: Math.round(slowest.duration - (slowest.processingEnd - slowest.start)),
    };
    const mostScript = Math.max(0, ...long.map(frame => frame.scriptMs));
    const parses = (window as unknown as {__parse: {name: string; start: number; duration: number}[]}).__parse.filter(call => call.start < to && call.start + call.duration > from);
    const worstParse = [...parses].sort((a, b) => b.duration - a.duration)[0] ?? null;
    return {frames, intervals, keys, worst, worstKey, mostScript, worstParse};
  }, {from, to});
  const sorted = [...numbers.intervals].sort((a, b) => a - b);
  const p90 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.9) - 1)] : 0;
  const share = sorted.length ? sorted.filter(value => value <= budget.intervalMs).length / sorted.length : 1;
  const line = {
    scenario: what.scenario, viewport, windowMs: Math.round(to - from),
    worstLongFrameMs: Math.round(Math.max(0, ...numbers.frames)), longFrames: numbers.frames.length, mostScriptMs: numbers.mostScript,
    rafP90Ms: Math.round(p90 * 10) / 10, rafShareWithinBudget: Math.round(share * 1000) / 1000, rafIntervals: sorted.length,
    worstKeystrokeMs: numbers.keys.length ? Math.max(...numbers.keys) : null, keystrokeEntries: numbers.keys.length, worstKeystroke: numbers.worstKey,
    worstFrame: numbers.worst && {scriptMs: numbers.worst.scriptMs, renderMs: numbers.worst.renderMs, styleLayoutMs: numbers.worst.styleLayoutMs, forcedStyleLayoutMs: numbers.worst.forcedStyleLayoutMs, scripts: numbers.worst.scripts},
    worstMainParseMs: numbers.worstParse ? Math.round(numbers.worstParse.duration) : 0, worstMainParse: numbers.worstParse?.name ?? null,
  };
  mkdirSync(path.dirname(resultFile), {recursive: true});
  appendFileSync(resultFile, JSON.stringify(line) + '\n');
  console.log('perf ' + JSON.stringify(line));
  if (what.frames !== false && line.worstLongFrameMs > budget.longFrameMs) failures.push(`${viewport} ${what.scenario}: long animation frame ${line.worstLongFrameMs} ms > ${budget.longFrameMs} ms`);
  // (b) is measured and written above; by human decision Q84 it does not fail the run.
  if (what.keys && line.worstKeystrokeMs !== null && line.worstKeystrokeMs > budget.keystrokeMs) failures.push(`${viewport} ${what.scenario}: keystroke ${line.worstKeystrokeMs} ms > ${budget.keystrokeMs} ms`);
  if (what.parse && line.worstMainParseMs > budget.mainParseMs) failures.push(`${viewport} ${what.scenario}: main-thread parse ${line.worstMainParseMs} ms (${line.worstMainParse}) > ${budget.mainParseMs} ms`);
}

/**
 * One data refresh as the console does it on the serverdesk:refresh event (the top-bar refresh, a change elsewhere):
 * the window runs from the event until the answer is in and its render is done.
 */
async function refreshData(page: Page): Promise<void> {
  const answer = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === '/api/console' && !url.searchParams.has('jobsOnly') && response.request().method() === 'GET';
  });
  await page.evaluate(() => window.dispatchEvent(new Event('serverdesk:refresh')));
  await answer;
  // The merge runs in slices and the render is a transition; both are done well within this time, also at 4×.
  await page.waitForTimeout(1500);
}

/** Runs action inside a CDP performance trace of the page's renderer (all its threads) and writes it to file. */
async function traced(cdp: CDPSession, file: string, action: () => Promise<void>): Promise<void> {
  const events: unknown[] = [];
  cdp.on('Tracing.dataCollected', ({value}) => { events.push(...value); });
  const complete = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve));
  await cdp.send('Tracing.start', {transferMode: 'ReportEvents', traceConfig: {includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'v8.execute', 'toplevel', '__metadata']}});
  await action();
  await cdp.send('Tracing.end');
  await complete;
  mkdirSync(path.dirname(file), {recursive: true});
  writeFileSync(file, JSON.stringify({traceEvents: events}));
}

/** Scrolls the element for 3 s, down and back up: the wheel on the desktop, touch drags on a phone. */
async function scrollFor(page: Page, cdp: CDPSession, selector: string, touch: boolean): Promise<void> {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`${selector} is not on screen`);
  const x = Math.round(box.x + box.width / 2), y = Math.round(box.y + box.height / 2);
  const end = Date.now() + scrollMs;
  let direction = 1;
  if (!touch) await page.mouse.move(x, y);
  while (Date.now() < end) {
    const edge = await page.locator(selector).evaluate((element, down) => down > 0 ? element.scrollTop + element.clientHeight >= element.scrollHeight - 2 : element.scrollTop <= 0, direction);
    if (edge) direction = -direction;
    if (touch) await cdp.send('Input.synthesizeScrollGesture', {x, y, yDistance: -direction * Math.min(400, Math.round(box.height * 0.6)), speed: 1200, gestureSourceType: 'touch'});
    else {
      await page.mouse.wheel(0, direction * 100);
      await page.waitForTimeout(16);
    }
  }
}

async function signIn(page: Page): Promise<void> {
  const owner = requireOwner();
  // The measurements run on the device list, so the sign-in opens its link (without one the Dashboard opens).
  await page.goto('/#devices');
  await page.getByLabel('Benutzername').fill(owner.username);
  await fillSecret(page.getByLabel('Passwort'), owner.password);
  await page.getByRole('button', {name: 'Anmelden', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'Anmelden', exact: true})).toBeVisible();
  const {code, counter} = await nextTotp(owner.secret, owner.lastCounter);
  // The counter is spent as soon as the code is sent, whatever the outcome.
  writeOwner({...owner, lastCounter: counter});
  await page.getByLabel('Authenticator-Code').fill(code);
  const closeNotice = closeUsageNoticeAfter(page);
  await page.getByRole('button', {name: 'Anmelden', exact: true}).click();
  await expectFleet(page);
  await closeNotice();
}

const viewports = [
  {name: 'desktop-1440', use: {viewport: {width: 1440, height: 900}}, throttle: 1, touch: false},
  {name: 'phone-390', use: {viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true}, throttle: 4, touch: true},
] as const;

for (const viewport of viewports) {
  test.describe(viewport.name, () => {
    test.use(viewport.use);

    test(`Palette und Hilfe ${viewport.name}`, async ({page}) => {
      test.setTimeout(240_000);
      const data = fleet();
      // 'unchanged' serves the same devices on every request; 'heartbeat' serves them as a 30 s refresh does: every
      // lastSeen at the time of the request and new CPU and RAM values, a different answer each time.
      let answer: 'unchanged' | 'heartbeat' = 'unchanged', beat = 0;
      const heartbeat = () => {
        const at = Date.now();
        beat++;
        return data.servers.map((server, index) => ({...server, lastSeen: at, snapshot: server.snapshot ? {...server.snapshot, cpu: (index * 7 + beat * 13) % 97, memory: (index * 11 + beat * 5) % 89} : null}));
      };
      await page.route('**/api/console*', async route => {
        const url = new URL(route.request().url());
        if (route.request().method() !== 'GET' || url.searchParams.has('jobsOnly')) return route.continue();
        const response = await route.fetch();
        const body = await response.json() as Record<string, unknown>;
        await route.fulfill({response, json: {...body, servers: answer === 'heartbeat' ? heartbeat() : data.servers, deviceGroups: data.deviceGroups}});
      });
      await page.addInitScript(recorder);
      await page.addInitScript(parseRecorder);
      await page.addInitScript(firstLoadRecorder);
      await signIn(page);
      await expect(page.locator('.sdx-fleet .sdx-device-cell, .sdx-fleet .sdx-device-card').first()).toBeVisible();
      // Let the first load, its entrance and the fonts settle before the clock-only state that is measured.
      await page.evaluate(async () => { await document.fonts.ready; });
      await page.waitForTimeout(1500);

      const cdp = await page.context().newCDPSession(page);
      if (viewport.throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', {rate: viewport.throttle});
      const failures: string[] = [];
      const name = viewport.name;
      const palette = page.getByRole('dialog', {name: translate('de', 'palette.title')});
      const field = palette.getByRole('combobox');
      const help = page.getByRole('dialog', {name: translate('de', 'help.title')});
      const options = palette.getByRole('option');

      // The console alone for 3 s (its 1 s clock), also the reference for the overlay numbers.
      await measure(page, name, failures, {scenario: 'console-idle-reference'}, () => page.waitForTimeout(scrollMs));
      // A refresh whose answer equals the shown data, then the realistic one: every device reported again.
      const trace = process.env.E2E_PERF_TRACE && viewport.throttle > 1 ? (window: string) => path.join(artifactsDir, 'perf', `${process.env.E2E_PERF_TRACE}-${window}.json`) : null;
      await measure(page, name, failures, {scenario: 'console-refresh-unchanged', parse: true}, () => trace ? traced(cdp, trace('unchanged'), () => refreshData(page)) : refreshData(page));
      answer = 'heartbeat';
      await measure(page, name, failures, {scenario: 'console-refresh-heartbeat', parse: true}, () => trace ? traced(cdp, trace('heartbeat'), () => refreshData(page)) : refreshData(page));

      // Ctrl K: open, type "srv", scroll, ↓ 20 times, Esc.
      await page.locator('#console-content').focus();
      await measure(page, name, failures, {scenario: 'palette-open-ctrl-k', intervals: true, keys: true}, async () => {
        await page.keyboard.press('Control+k');
        await nextPaint(page);
        await expect(field).toBeFocused();
        await animationsDone(page);
      });
      // The palette mounts its first rows at once and the rest in steps after the entrance.
      await expect.poll(() => options.count(), {message: 'the palette lists at least 280 items'}).toBeGreaterThanOrEqual(280);
      await measure(page, name, failures, {scenario: 'palette-type-srv', keys: true}, async () => {
        for (const key of 'srv') {
          await page.keyboard.press(key);
          await page.waitForTimeout(150);
        }
        await expect(field).toHaveValue('srv');
      });
      await measure(page, name, failures, {scenario: 'palette-scroll', intervals: true}, () => scrollFor(page, cdp, '.sd-palette-results', viewport.touch));
      await measure(page, name, failures, {scenario: 'palette-arrow-down-20', keys: true}, async () => {
        await field.focus();
        for (let step = 0; step < 20; step++) {
          await page.keyboard.press('ArrowDown');
          await page.waitForTimeout(60);
        }
      });
      // A refresh while the palette is open.
      await measure(page, name, failures, {scenario: 'console-refresh-heartbeat-palette', parse: true}, () => refreshData(page));
      await field.focus();
      await measure(page, name, failures, {scenario: 'palette-close-esc', keys: true}, async () => {
        await page.keyboard.press('Escape');
        await nextPaint(page);
        await expect(palette).toBeHidden();
        await goneFromDocument(page, '.sd-palette');
        await animationsDone(page);
      });

      // The top-bar search: open, then Esc.
      await measure(page, name, failures, {scenario: 'palette-open-topbar', intervals: true}, async () => {
        await page.locator('.sdx-search').click();
        await expect(field).toBeFocused();
        await animationsDone(page);
      });
      await page.keyboard.press('Escape');
      await expect(palette).toBeHidden();
      await goneFromDocument(page, '.sd-palette');

      // Help: F1, scroll its body, Esc from inside; the top-bar help button, then its close button.
      await page.locator('#console-content').focus();
      await measure(page, name, failures, {scenario: 'help-open-f1', intervals: true, keys: true}, async () => {
        await page.keyboard.press('F1');
        await nextPaint(page);
        await expect(help).toBeVisible();
        await animationsDone(page);
      });
      await measure(page, name, failures, {scenario: 'help-scroll', intervals: true}, () => scrollFor(page, cdp, '.sdx-drawer-nonmodal .sdx-drawer-body', viewport.touch));
      // A refresh while Help is open.
      await measure(page, name, failures, {scenario: 'console-refresh-heartbeat-help', parse: true}, () => refreshData(page));
      await measure(page, name, failures, {scenario: 'help-close-esc', keys: true}, async () => {
        await help.focus();
        await page.keyboard.press('Escape');
        await nextPaint(page);
        await expect(help).toBeHidden();
        await goneFromDocument(page, '.sdx-drawer-nonmodal');
        await animationsDone(page);
      });
      await measure(page, name, failures, {scenario: 'help-open-topbar', intervals: true}, async () => {
        await page.locator('.sdx-topbar').getByRole('button', {name: translate('de', 'shell.help'), exact: true}).click();
        await expect(help).toBeVisible();
        await animationsDone(page);
      });
      await measure(page, name, failures, {scenario: 'help-close-button'}, async () => {
        await help.getByRole('button', {name: translate('de', 'kit.close'), exact: true}).click();
        await expect(help).toBeHidden();
        await animationsDone(page);
      });

      // The first load at the same viewport and throttling (the CDP session's throttling outlives the reload).
      await firstLoad(page, name);

      if (viewport.throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', {rate: 1});
      expect(failures, 'the frame budget of the workspace, the palette and Help').toEqual([]);
    });
  });
}
