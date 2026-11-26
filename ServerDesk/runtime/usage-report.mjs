import packageJson from '../package.json' with { type: 'json' };
import {sql} from './database.mjs';

// Usage data for product improvement (docs/usage-data.md). The payload carries
// three values and the schema number without any personal reference, and the
// report goes out only from the daily maintenance, at most once in 20 hours, only after an Owner's consent and only to
// the usage data server at LICENSE_SERVER_URL, and only while usageDataEnabled() says the function is on.
// Nothing here logs, audits or evaluates a server response.

/**
 * The one switch for usage data. It is off in this version, for every env: there is no usage data server yet,
 * so nothing is sent, no Owner is asked, and the page Settings › Usage data shows the card locked. The server
 * (lib/server/usage-data.ts) and the maintenance (sendUsageReport) call only this function, and the UI reads
 * only the view's `enabled`. To turn usage data on later, change only this body, for example to
 * `return licenseServer(env?.LICENSE_SERVER_URL).state === 'configured';`.
 * @param {{LICENSE_SERVER_URL?: string}} [env]
 * @returns {boolean}
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- env stays in the signature, so the later condition needs no change at the callers
export function usageDataEnabled(env) {
  return false;
}

/** The portal version from package.json, or 'unknown' if it is missing or malformed. */
export function portalVersion(value = packageJson.version) {
  return typeof value === 'string' && /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(value) ? value : 'unknown';
}

const localHosts = ['localhost', '127.0.0.1', '[::1]'];

/**
 * Checks LICENSE_SERVER_URL: an absolute https URL (http only for localhost,
 * like SITE_ORIGIN), without credentials, query or fragment; a path is allowed.
 * Returns the base URL with a trailing slash, or the reason it is unusable.
 */
export function licenseServer(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return { state: 'none' };
  let url;
  try { url = new URL(text); } catch { return { state: 'invalid' }; }
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && localHosts.includes(url.hostname));
  if (!secure || url.username || url.password || url.search || url.hash || text.includes('?') || text.includes('#')) return { state: 'invalid' };
  return { state: 'configured', base: url.href.endsWith('/') ? url.href : url.href + '/' };
}

/** 'none' | 'invalid' | 'configured', for the settings page; the URL itself never leaves the server. */
export const licenseServerState = value => licenseServer(value).state;

/** The payload, exactly these four keys. */
export async function usagePayload(database) {
  const row = await database.one(sql`SELECT
    (SELECT instance_id FROM usage_data WHERE id=1) AS instance_id,
    (SELECT count(*) FROM servers WHERE revoked=0) AS devices`);
  if (!row || typeof row.instance_id !== 'string') throw new Error('usage_data is missing');
  return { schema: 2, instanceId: row.instance_id, version: portalVersion(), deviceCount: Number(row.devices) };
}

const dueAfter = 20 * 3_600_000;

// The client for the message to the usage data server: the usage report (v1/usage).
async function postToLicenseServer(base, path, body, { fetch, version }) {
  try {
    const response = await fetch(new URL(path, base).href, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': `ServerDesk/${version}` },
      body: JSON.stringify(body),
      redirect: 'error',
      credentials: 'omit',
      signal: AbortSignal.timeout(10_000),
    });
    // The body is neither read nor logged; cancel it so the connection is released.
    try { await response.body?.cancel(); } catch { /* the status alone decides */ }
    return response.status >= 200 && response.status < 300 ? { ok: true } : { ok: false, error: `http-${response.status}` };
  } catch (error) {
    return { ok: false, error: error?.name === 'TimeoutError' ? 'timeout' : 'network' };
  }
}

/**
 * The daily usage report of the maintenance (runtime/maintenance.mjs). Never throws. While usage data is
 * off (`enabled`, by default usageDataEnabled(env)) and without LICENSE_SERVER_URL it touches neither the
 * network nor the database. Only tests pass `enabled`.
 * @returns {Promise<{status:'disabled'|'no-server'|'invalid-server'|'no-consent'|'not-due'|'sent'}|{status:'failed',error:string}>}
 */
export async function sendUsageReport(database, { env = {}, fetch, now = Date.now(), enabled = usageDataEnabled(env) } = {}) {
  if (enabled !== true) return { status: 'disabled' };
  const server = licenseServer(env?.LICENSE_SERVER_URL);
  if (server.state === 'none') return { status: 'no-server' };
  if (server.state === 'invalid') return { status: 'invalid-server' };
  try {
    const consent = await database.one(sql`SELECT consent FROM usage_data WHERE id=1`).then(row=>row===null?null:row.consent);
    if (consent !== 1) return { status: 'no-consent' };
    // Claim the attempt atomically: of two concurrent runs only one sends, and a
    // failed attempt is due again only after 20 hours as well.
    const claim = await database.exec(sql`UPDATE usage_data SET last_attempt_at=${now} WHERE id=1 AND consent=1 AND (last_attempt_at IS NULL OR last_attempt_at<=${now - dueAfter})`);
    if (!claim.rowCount) return { status: 'not-due' };
    const payload = await usagePayload(database);
    const result = await postToLicenseServer(server.base, 'v1/usage', payload, { fetch, version: payload.version });
    if (result.ok) {
      await database.exec(sql`UPDATE usage_data SET last_success_at=${now}, last_error=NULL WHERE id=1`);
      return { status: 'sent' };
    }
    await database.exec(sql`UPDATE usage_data SET last_error=${result.error} WHERE id=1`);
    return { status: 'failed', error: result.error };
  } catch {
    return { status: 'failed', error: 'internal' };
  }
}
