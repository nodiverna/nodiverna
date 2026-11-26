import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Load the real report module as JavaScript; it uses Web APIs only.
const source = await readFile(new URL('../../lib/server/csp-reports.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const reports = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
const { acceptedReportType, createReportLimiter, readReportBody, reportClientKey, summarizeReports, ReportError } = reports;

let cases = 0;
async function test(name, run) { await run(); cases++; console.log('PASS ' + name); }
const rejects = async (run, status) => assert.rejects(run, error => error instanceof ReportError && error.status === status);
const throwsStatus = (run, status) => assert.throws(run, error => error instanceof ReportError && error.status === status);

const leaky = {
  'document-uri': 'https://portal.example/?invite=abc#token=def',
  referrer: 'https://referrer.example/?referrer-secret',
  'violated-directive': 'script-src-elem',
  'effective-directive': 'script-src-elem',
  'original-policy': "script-src 'self' 'nonce-XYZ' 'strict-dynamic'",
  disposition: 'report',
  'blocked-uri': 'https://evil.example/x?token=secret#frag',
  'line-number': 12,
  'column-number': 4,
  'source-file': 'https://portal.example/_next/static/app.js?v=secret#frag',
  'status-code': 200,
  'script-sample': 'alert(1)',
};
const asReportingApi = report => ({
  type: 'csp-violation', age: 3, url: 'https://portal.example/?wrapper-secret', user_agent: 'Agent/1.0',
  body: {
    documentURL: report['document-uri'], referrer: report.referrer, blockedURL: report['blocked-uri'],
    effectiveDirective: report['effective-directive'], originalPolicy: report['original-policy'],
    sourceFile: report['source-file'], sample: report['script-sample'], disposition: report.disposition,
    statusCode: report['status-code'], lineNumber: report['line-number'], columnNumber: report['column-number'],
  },
});
const one = report => summarizeReports({ 'csp-report': report }).violations[0];

await test('the module has no imports', () => {
  assert.doesNotMatch(source, /^\s*import\b|\brequire\(|\bimport\(/m);
});

await test('report-uri and Reporting API payloads give the same reduced summary', () => {
  const summary = summarizeReports({ 'csp-report': leaky });
  assert.deepEqual(summary, {
    count: 1,
    violations: [{ directive: 'script-src-elem', blocked: 'https://evil.example', document: 'https://portal.example/', source: 'https://portal.example/_next/static/app.js', line: 12, column: 4, disposition: 'report', status: 200 }],
  });
  assert.deepEqual(summarizeReports([asReportingApi(leaky)]), summary);
  const text = JSON.stringify(summary);
  for (const secret of ['secret', 'frag', 'invite', 'token', 'alert', 'XYZ', 'nonce', 'referrer', 'Agent', 'wrapper']) assert.ok(!text.includes(secret), `summary leaks ${secret}: ${text}`);
});

await test('blocked keeps keywords, reduces URLs to origin and other schemes to the scheme', () => {
  for (const keyword of ['inline', 'eval', 'wasm-eval', 'self', 'trusted-types-policy', 'trusted-types-sink']) assert.equal(one({ 'blocked-uri': keyword }).blocked, keyword);
  assert.equal(one({ 'blocked-uri': 'data:text/javascript,alert(1)' }).blocked, 'data');
  assert.equal(one({ 'blocked-uri': 'blob:https://portal.example/1234' }).blocked, 'blob');
  assert.equal(one({ 'blocked-uri': 'https://user:pass@evil.example:8443/a?b#c' }).blocked, 'https://evil.example:8443');
  assert.equal(one({ 'blocked-uri': 'HTTP://Evil.Example/' }).blocked, 'http://evil.example');
  for (const value of ['inline\nforged', '/relative/path', 'not a url', 42, null]) assert.equal(one({ 'blocked-uri': value }).blocked, undefined, String(value));
});

await test('document and source keep origin plus path without credentials, query or fragment', () => {
  const violation = one({ 'document-uri': 'https://user:pass@portal.example/devices/1?x=1#y', 'source-file': 'https://portal.example/' + 'a'.repeat(300) });
  assert.equal(violation.document, 'https://portal.example/devices/1');
  assert.equal(violation.source, 'https://portal.example/' + 'a'.repeat(199), 'path is capped at 200 characters');
  assert.equal(one({ 'document-uri': 'about:blank', 'source-file': 'chrome-extension://abc/x.js' }).document, undefined);
  assert.equal(one({ 'source-file': 'chrome-extension://abc/x.js' }).source, undefined);
  assert.equal(one({ 'document-uri': 'https://portal.example/a\nb' }).document, 'https://portal.example/ab', 'URL parsing strips line breaks');
});

await test('directive comes from effective or the first word of violated, and must be lowercase', () => {
  assert.equal(one({ 'violated-directive': "script-src-elem 'self'" }).directive, 'script-src-elem');
  assert.equal(one({ 'effective-directive': 'connect-src', 'violated-directive': 'default-src' }).directive, 'connect-src');
  assert.equal(one({ 'effective-directive': 'script-src\ncsp-report {"forged":1}' }).directive, undefined);
  assert.equal(one({ 'effective-directive': 'Script-Src' }).directive, undefined);
  assert.equal(one({ 'violated-directive': 'x'.repeat(65) }).directive, undefined);
});

await test('numbers are non-negative integers and disposition is report or enforce', () => {
  assert.deepEqual(one({ 'line-number': 1.5, 'column-number': -1, 'status-code': '200', disposition: 'other' }), {});
  assert.deepEqual(one({ 'line-number': 0, 'column-number': 7, 'status-code': 0, disposition: 'enforce' }), { line: 0, column: 7, status: 0, disposition: 'enforce' });
});

await test('a log line stays one line whatever the field values hold', () => {
  const hostile = '\u2028\u2029\r\n\u0000';
  const summary = summarizeReports({ 'csp-report': Object.fromEntries(Object.keys(leaky).map(key => [key, hostile + 'x'])) });
  const line = 'csp-report ' + JSON.stringify(summary);
  assert.doesNotMatch(line, /[\u0000-\u001f\u2028\u2029]/);
});

await test('arrays count every violation, log ten and ignore other report types', () => {
  const batch = Array.from({ length: 15 }, (_, index) => asReportingApi({ ...leaky, 'line-number': index }));
  batch.splice(3, 0, { type: 'deprecation', body: { id: 'x' } });
  batch.push({ type: 'intervention', body: {} });
  const summary = summarizeReports(batch);
  assert.equal(summary.count, 15);
  assert.equal(summary.violations.length, 10);
  assert.deepEqual(summary.violations.map(violation => violation.line), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(summarizeReports([{ type: 'deprecation', body: {} }]), { count: 0, violations: [] });
  assert.deepEqual(summarizeReports([]), { count: 0, violations: [] });
});

await test('other JSON shapes are bad requests', () => {
  for (const payload of [null, 1, 'x', {}, { 'csp-report': 1 }, { 'csp-report': [] }, [1], [null], [[]], [{ type: 'csp-violation' }], [{ type: 'csp-violation', body: 'x' }]]) {
    throwsStatus(() => summarizeReports(payload), 400);
  }
});

const post = (body, headers = {}) => new Request('https://portal.example/api/csp-report', { method: 'POST', body, headers, duplex: 'half' });

await test('body reader enforces the size limit before and while reading', async () => {
  const oversized = post(new ReadableStream({ pull() { assert.fail('an oversized Content-Length is rejected without reading'); } }, { highWaterMark: 0 }), { 'Content-Length': '20000' });
  await rejects(() => readReportBody(oversized), 413);
  assert.equal(oversized.bodyUsed, false, 'the body was never read');
  let sent = 0, cancelled = false;
  const stream = new ReadableStream({
    pull(controller) {
      if (sent >= 16_385) return controller.close();
      const size = Math.min(1_000, 16_385 - sent);
      sent += size;
      controller.enqueue(new Uint8Array(size).fill(32));
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  await rejects(() => readReportBody(post(stream)), 413);
  assert.equal(cancelled, true, 'the stream is cancelled at the limit');
  let endless = 0, stopped = false;
  const infinite = new ReadableStream({ pull(controller) { endless++; controller.enqueue(new Uint8Array(4_096)); }, cancel() { stopped = true; } }, { highWaterMark: 0 });
  await rejects(() => readReportBody(post(infinite)), 413);
  assert.ok(stopped && endless <= 6, `an endless body stops at the limit (${endless} chunks)`);
  assert.deepEqual(await readReportBody(post(JSON.stringify({ 'csp-report': {} }).padEnd(16_384, ' '))), { 'csp-report': {} });
});

await test('an invalid Content-Length is a bad request and the body is not read', async () => {
  for (const length of ['abc', '-1', '1.5', '1e9', '0x10', '12, 12', 'NaN', '']) {
    const request = post(new ReadableStream({ pull() { assert.fail('an invalid Content-Length is rejected without reading'); } }, { highWaterMark: 0 }), { 'Content-Length': length });
    await rejects(() => readReportBody(request), 400);
    assert.equal(request.bodyUsed, false, `the body was never read (${JSON.stringify(length)})`);
  }
  const body = JSON.stringify({ 'csp-report': {} });
  assert.deepEqual(await readReportBody(post(body, { 'Content-Length': String(body.length) })), { 'csp-report': {} }, 'a decimal Content-Length still passes');
});

await test('body reader rejects invalid UTF-8 and invalid JSON as bad requests', async () => {
  await rejects(() => readReportBody(post(new Uint8Array([0x7b, 0xff, 0x7d]))), 400);
  await rejects(() => readReportBody(post('{"csp-report":')), 400);
  await rejects(() => readReportBody(post('')), 400);
});

await test('content types are compared without parameters', () => {
  for (const type of ['application/csp-report; charset=utf-8', 'application/reports+json', 'application/json', 'Application/JSON;charset=UTF-8']) assert.equal(acceptedReportType(type), true, type);
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', '', null]) assert.equal(acceptedReportType(type), false, String(type));
});

await test('client key is the proxy-set IP header or the shared ingress bucket', () => {
  assert.equal(reportClientKey(new Headers({ 'X-ServerDesk-Client-IP': '203.0.113.7' })), '203.0.113.7');
  assert.equal(reportClientKey(new Headers()), 'unknown-ingress');
});

await test('limiter allows 20 requests per key and fixed 60 second window', () => {
  let time = 1_000;
  const allow = createReportLimiter({ now: () => time });
  for (let index = 0; index < 20; index++) assert.equal(allow('a'), true, `hit ${index + 1}`);
  assert.equal(allow('a'), false, 'hit 21 is rejected');
  assert.equal(allow('b'), true, 'other keys keep their own window');
  time += 59_999;
  assert.equal(allow('a'), false, 'the window is fixed, not sliding');
  time += 1;
  assert.equal(allow('a'), true, 'the next window accepts the key again');
});

await test('limiter keeps at most 1024 keys and frees expired windows first', () => {
  let time = 0;
  const allow = createReportLimiter({ now: () => time, globalLimit: Infinity });
  for (let index = 0; index < 1_024; index++) assert.equal(allow('key-' + index), true);
  assert.equal(allow('new'), false, 'a full table of live windows rejects new keys');
  assert.equal(allow('key-5'), true, 'known keys still use their window');
  time += 60_000;
  assert.equal(allow('new'), true, 'expired windows make room again');
  assert.equal(allow('another'), true);
});

await test('limiter caps the whole process at 200 accepted requests per 60 second window', () => {
  let time = 5_000;
  const allow = createReportLimiter({ now: () => time });
  for (let index = 0; index < 200; index++) assert.equal(allow('ip-' + index), true, `client ${index + 1}`);
  assert.equal(allow('ip-200'), false, 'a fresh key is rejected once the process budget is used');
  assert.equal(allow('ip-0'), false, 'a known key with room in its own window is rejected too');
  time += 59_999;
  assert.equal(allow('ip-201'), false, 'the process window is fixed, not sliding');
  time += 1;
  for (let index = 0; index < 200; index++) assert.equal(allow('next-' + index), true, `next window client ${index + 1}`);
  assert.equal(allow('next-200'), false);
});

await test('rejected requests do not use the process budget', () => {
  const allow = createReportLimiter({ now: () => 0 });
  for (let index = 0; index < 20; index++) assert.equal(allow('flood'), true);
  for (let index = 0; index < 500; index++) assert.equal(allow('flood'), false, 'per-key rejections');
  for (let index = 0; index < 180; index++) assert.equal(allow('ip-' + index), true, `client ${index + 1}`);
  assert.equal(allow('last'), false, '20 + 180 accepted requests fill the budget');
});

await test('dropped requests are reported once per process window', () => {
  let time = 0;
  const timers = [], dropped = [];
  const allow = createReportLimiter({ now: () => time, onDropped: count => dropped.push(count), schedule: (run, ms) => timers.push({ run, at: time + ms }) });
  for (let index = 0; index < 20; index++) assert.equal(allow('a'), true);
  assert.equal(timers.length, 0, 'no timer while nothing is dropped');
  for (let index = 0; index < 5; index++) assert.equal(allow('a'), false, 'per-key rejections count as dropped');
  assert.equal(timers.length, 1, 'the first drop schedules one report');
  assert.equal(timers[0].at, 60_000, 'the report runs when the process window ends');
  time = 30_000;
  for (let index = 0; index < 180; index++) assert.equal(allow('ip-' + index), true);
  for (let index = 0; index < 3; index++) assert.equal(allow('late-' + index), false, 'process-cap rejections count as dropped');
  assert.equal(timers.length, 1, 'still one timer per window');
  assert.deepEqual(dropped, [], 'nothing is reported before the window ends');
  time = 60_000;
  timers[0].run();
  assert.deepEqual(dropped, [8], 'one report with every drop of the window');
  timers[0].run();
  assert.deepEqual(dropped, [8], 'a window is reported once');
  assert.equal(allow('a'), true, 'the next window starts');
  for (let index = 0; index < 19; index++) assert.equal(allow('a'), true);
  assert.equal(allow('a'), false);
  assert.equal(allow('a'), false);
  assert.equal(timers.length, 2);
  time = 120_000;
  assert.equal(allow('b'), true);
  assert.deepEqual(dropped, [8, 2], 'the first request of a new window reports drops a late timer has not reported');
  timers[1].run();
  assert.deepEqual(dropped, [8, 2], 'the late timer does not report the window again');
  time = 180_000;
  assert.equal(allow('c'), true);
  assert.equal(timers.length, 2);
  assert.deepEqual(dropped, [8, 2], 'windows without drops write nothing');
});

await test('the default schedule reports drops after the window ends', async () => {
  const dropped = [];
  const allow = createReportLimiter({ limit: 1, windowMs: 20, onDropped: count => dropped.push(count) });
  assert.equal(allow('a'), true);
  assert.equal(allow('a'), false);
  assert.equal(allow('a'), false);
  for (let attempt = 0; attempt < 40 && !dropped.length; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(dropped, [2]);
});

await test('every logged origin is capped at 255 characters', () => {
  const host = 'a'.repeat(300) + '.example';
  const violation = one({ 'blocked-uri': `https://${host}:8443/x?secret`, 'document-uri': `https://${host}/devices/1`, 'source-file': `http://${host}/${'b'.repeat(300)}` });
  assert.equal(violation.blocked, ('https://' + host).slice(0, 255));
  assert.equal(violation.blocked.length, 255);
  assert.equal(violation.document, ('https://' + host).slice(0, 255) + '/devices/1');
  assert.equal(violation.source, ('http://' + host).slice(0, 255) + '/' + 'b'.repeat(199), 'origin and path are capped separately');
  assert.equal(one({ 'blocked-uri': 'https://' + 'c'.repeat(247) }).blocked, 'https://' + 'c'.repeat(247), 'a 255-character origin stays whole');
  const summary = summarizeReports(Array.from({ length: 10 }, () => asReportingApi({ 'blocked-uri': `https://${host}/`, 'document-uri': `https://${host}/${'d'.repeat(300)}`, 'source-file': `https://${host}/${'e'.repeat(300)}`, 'effective-directive': 'script-src-elem' })));
  assert.ok(JSON.stringify(summary).length < 10 * (255 * 3 + 2 * 200 + 120), 'a full summary stays bounded');
});

console.log(`${cases} CSP report cases passed.`);
