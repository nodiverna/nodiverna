import { readFileSync } from 'node:fs';
import { previousSecrets } from './secret-keyring.mjs';
import { createStorage } from './storage.mjs';

const stateKey = Symbol.for('serverdesk.runtime.bindings');
const localDatabaseHosts = new Set(['db', 'localhost', '127.0.0.1', '::1', '[::1]']);
const tlsModes = new Set(['require', 'verify-ca', 'verify-full']);

/**
 * DATABASE_URL is postgres://user@host:port/database without a password (the
 * password is DATABASE_PASSWORD). A host other than the Compose service db or
 * the local machine needs TLS: sslmode require, verify-ca or verify-full.
 */
export function validateDatabaseUrl(value) {
  if (!value) throw new Error('DATABASE_URL is required: postgres://serverdesk@db:5432/serverdesk (the password goes into DATABASE_PASSWORD).');
  let url;
  try { url = new URL(value); } catch { throw new Error('DATABASE_URL must be a URL such as postgres://serverdesk@db:5432/serverdesk.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('DATABASE_URL must start with postgres:// or postgresql://.');
  if (url.password) throw new Error('DATABASE_URL must not contain a password; put it into DATABASE_PASSWORD.');
  if (!url.username || !url.hostname || !url.port || url.pathname.replace(/^\//, '') === '') throw new Error('DATABASE_URL needs a user, host, port and database: postgres://serverdesk@db:5432/serverdesk.');
  if (!localDatabaseHosts.has(url.hostname) && !tlsModes.has(url.searchParams.get('sslmode') ?? '')) {
    throw new Error('A DATABASE_URL to a remote host requires TLS: add ?sslmode=require, verify-ca or verify-full.');
  }
}
const state = globalThis[stateKey] ??= {};

export function validateEnvironment(config = process.env) {
  for (const key of ['SESSION_SECRET', 'PASSWORD_PEPPER']) {
    if (Buffer.byteLength(config[key] ?? '', 'utf8') < 32) throw new Error(`${key} needs at least 32 random bytes.`);
  }
  // Old secrets that still decrypt during a SESSION_SECRET change (docs/self-hosting.md).
  if (previousSecrets(config.SESSION_SECRET_PREVIOUS).some(secret => Buffer.byteLength(secret, 'utf8') < 32)) {
    throw new Error('SESSION_SECRET_PREVIOUS entries need at least 32 random bytes each.');
  }
  const origin = new URL(config.SITE_ORIGIN ?? '');
  if (origin.origin !== config.SITE_ORIGIN || origin.username || origin.password) throw new Error('SITE_ORIGIN must be an exact origin without path or credentials.');
  if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) throw new Error('SITE_ORIGIN requires HTTPS, except for localhost development.');
  validateDatabaseUrl(config.DATABASE_URL);
  if (Number(config.WEB_CONCURRENCY ?? 1) > 1 && (config.OBJECT_STORAGE_DRIVER ?? 'filesystem') === 'filesystem') {
    throw new Error('Multiple web replicas require shared object storage.');
  }
}

// Lazy bindings allow secret-free builds and keep one shared connection even
// when Next loads separate route bundles or reloads a module during development.
export const env = new Proxy({}, { get(_target, key) {
  if (key === 'BUCKET') return state.storage ??= createStorage();
  if (key === 'AGENT_JOB_SIGNING_KEY' && process.env.AGENT_JOB_SIGNING_KEY_FILE) return state.jobSigningKey ??= readFileSync(process.env.AGENT_JOB_SIGNING_KEY_FILE, 'utf8');
  return process.env[key] ?? '';
} });
