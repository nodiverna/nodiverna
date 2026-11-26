// CSP violation reports. The sink is anonymous, so everything here is
// bounded: request size, requests per client and per process, and the logged
// fields. Only the directive, reduced locations and numbers are kept; samples,
// the policy (it holds the nonce), referrers, queries and fragments never leave
// this module.
// No imports, so plain Node tests can load it through ts.transpileModule.

export const REPORT_BODY_LIMIT = 16_384;
export const REPORT_RATE_LIMIT = 20;
export const REPORT_RATE_WINDOW_MS = 60_000;
export const REPORT_RATE_KEYS = 1_024;
// Each accepted request writes at most one line, so this caps the log of one
// process even when clients rotate their addresses.
export const REPORT_LOG_LIMIT = 200;
export const REPORT_LOGGED_VIOLATIONS = 10;
const PATH_LIMIT = 200;
const ORIGIN_LIMIT = 255;

export class ReportError extends Error {
  readonly status: 400 | 413;
  constructor(status: 400 | 413) {
    super(status === 413 ? 'CSP report too large' : 'Invalid CSP report');
    this.status = status;
  }
}

export type CspViolation = {
  directive?: string; blocked?: string; document?: string; source?: string;
  line?: number; column?: number; disposition?: string; status?: number;
};
export type CspSummary = { count: number; violations: CspViolation[] };

const reportTypes = new Set(['application/csp-report', 'application/reports+json', 'application/json']);
export function acceptedReportType(header: string | null): boolean {
  return reportTypes.has((header ?? '').split(';')[0].trim().toLowerCase());
}

// The proxy sets X-ServerDesk-Client-IP only from the trusted ingress header, so
// a missing value puts every client into one shared bucket.
export function reportClientKey(headers: Headers): string {
  return headers.get('x-serverdesk-client-ip')?.trim() || 'unknown-ingress';
}

// Waits in the background without keeping the process alive.
function later(run: () => void, ms: number) {
  const timer = setTimeout(run, ms) as unknown as { unref?: () => void };
  timer.unref?.();
}

// Fixed window per key. The table holds at most maxKeys entries; when it is
// full, expired windows are dropped first and otherwise the new key waits.
// A second fixed window counts every accepted request of the process, so at
// most globalLimit requests (and log lines) pass per window across all keys.
// Every refused request in a process window is counted, and onDropped gets
// that number once per window with drops: when the window ends (schedule), or
// on the first request after it if the timer has not run yet. A quiet log
// during a flood therefore still shows that reports were dropped.
export function createReportLimiter({ now = Date.now, limit = REPORT_RATE_LIMIT, windowMs = REPORT_RATE_WINDOW_MS, maxKeys = REPORT_RATE_KEYS, globalLimit = REPORT_LOG_LIMIT, onDropped = () => {}, schedule = later }: {
  now?: () => number; limit?: number; windowMs?: number; maxKeys?: number; globalLimit?: number;
  onDropped?: (dropped: number) => void; schedule?: (run: () => void, ms: number) => void;
} = {}) {
  const windows = new Map<string, { start: number; count: number }>();
  const total = { start: -Infinity, count: 0, dropped: 0 };
  const report = () => {
    if (!total.dropped) return;
    const dropped = total.dropped;
    total.dropped = 0;
    onDropped(dropped);
  };
  const drop = (time: number) => {
    if (total.dropped++ === 0) {
      const start = total.start;
      schedule(() => { if (total.start === start) report(); }, start + windowMs - time);
    }
    return false;
  };
  return function allow(key: string): boolean {
    const time = now();
    if (time - total.start >= windowMs) { report(); total.start = time; total.count = 0; }
    if (total.count >= globalLimit) return drop(time);
    let entry = windows.get(key);
    if (entry && time - entry.start >= windowMs) {
      windows.delete(key);
      entry = undefined;
    }
    if (!entry) {
      if (windows.size >= maxKeys) for (const [other, value] of windows) if (time - value.start >= windowMs) windows.delete(other);
      if (windows.size >= maxKeys) return drop(time);
      entry = { start: time, count: 0 };
      windows.set(key, entry);
    }
    if (entry.count >= limit) return drop(time);
    entry.count++;
    total.count++;
    return true;
  };
}

// Reads at most limit bytes and cancels the stream as soon as it goes past.
// A Content-Length that is not a plain decimal number is a bad request, so it
// can never slip past the early size check.
export async function readReportBody(request: Request, limit = REPORT_BODY_LIMIT): Promise<unknown> {
  const declared = request.headers.get('content-length');
  if (declared !== null && !/^\d+$/.test(declared)) throw new ReportError(400);
  if (Number(declared ?? 0) > limit) throw new ReportError(413);
  const chunks: Uint8Array[] = [], reader = request.body?.getReader();
  let length = 0;
  if (reader) {
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > limit) { await reader.cancel(); throw new ReportError(413); }
        chunks.push(chunk.value);
      }
    } catch (error) {
      throw error instanceof ReportError ? error : new ReportError(400);
    } finally { reader.releaseLock(); }
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new ReportError(400); }
}

type Fields = Record<string, unknown>;
const isObject = (value: unknown): value is Fields => typeof value === 'object' && value !== null && !Array.isArray(value);

// Accepts the report-uri object or a Reporting API array. Entries of other
// report types are ignored; anything else is a bad request.
export function summarizeReports(payload: unknown): CspSummary {
  const bodies: Fields[] = [];
  if (Array.isArray(payload)) {
    for (const entry of payload) {
      if (!isObject(entry)) throw new ReportError(400);
      if (entry.type !== 'csp-violation') continue;
      if (!isObject(entry.body)) throw new ReportError(400);
      bodies.push(reportingApi(entry.body));
    }
  } else if (isObject(payload) && isObject(payload['csp-report'])) bodies.push(payload['csp-report']);
  else throw new ReportError(400);
  return { count: bodies.length, violations: bodies.slice(0, REPORT_LOGGED_VIOLATIONS).map(reduce) };
}

// Maps the Reporting API names onto the report-uri names reduce() reads.
function reportingApi(body: Fields): Fields {
  return {
    'effective-directive': body.effectiveDirective, 'blocked-uri': body.blockedURL, 'document-uri': body.documentURL,
    'source-file': body.sourceFile, 'line-number': body.lineNumber, 'column-number': body.columnNumber,
    disposition: body.disposition, 'status-code': body.statusCode,
  };
}

function reduce(report: Fields): CspViolation {
  const violation: CspViolation = {
    directive: directive(report), blocked: blocked(report['blocked-uri']),
    document: location(report['document-uri']), source: location(report['source-file']),
    line: count(report['line-number']), column: count(report['column-number']),
    disposition: report.disposition === 'report' || report.disposition === 'enforce' ? report.disposition : undefined,
    status: count(report['status-code']),
  };
  return Object.fromEntries(Object.entries(violation).filter(([, value]) => value !== undefined)) as CspViolation;
}

function directive(report: Fields): string | undefined {
  const effective = report['effective-directive'], violated = report['violated-directive'];
  const value = typeof effective === 'string' && effective ? effective : typeof violated === 'string' ? violated.split(' ')[0] : undefined;
  return value !== undefined && /^[a-z-]{1,64}$/.test(value) ? value : undefined;
}

const keywords = new Set(['inline', 'eval', 'wasm-eval', 'self', 'trusted-types-policy', 'trusted-types-sink']);
// A foreign path or query can carry exfiltrated data, so only the origin stays.
function blocked(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (keywords.has(value)) return value;
  const url = parse(value);
  if (!url) return undefined;
  if (url.protocol === 'http:' || url.protocol === 'https:') return origin(url);
  const scheme = url.protocol.slice(0, -1);
  return /^[a-z][a-z0-9+.-]{0,31}$/.test(scheme) ? scheme : undefined;
}

// The portal's own pages and assets: origin plus path, never credentials,
// query or fragment (invitation and identity tokens live there).
function location(value: unknown): string | undefined {
  const url = typeof value === 'string' ? parse(value) : undefined;
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) return undefined;
  return origin(url) + url.pathname.slice(0, PATH_LIMIT);
}

// URL parsing accepts hosts far longer than DNS allows; cap them for the log.
function origin(url: URL): string {
  return url.origin.slice(0, ORIGIN_LIMIT);
}

function parse(value: string): URL | undefined {
  try { return new URL(value); } catch { return undefined; }
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
