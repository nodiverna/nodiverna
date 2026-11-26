// Keyring for values that are encrypted with a key derived from SESSION_SECRET
// (docs/self-hosting.md, "Change the session secret"). Web Crypto only, so the
// Next server (lib/server/identity/mfa.ts, lib/server/agent/device-tokens.ts) and the offline selfhost CLI
// (scripts/selfhost.mjs rewrap-secrets) use the same derivation.
//
// Every purpose gets its own HKDF-SHA-256 key. A ciphertext has the form
// k1.<kid>.<iv>.<data>: kid names the secret that encrypted it, so a value made
// under SESSION_SECRET_PREVIOUS stays readable after a rotation until
// rewrap-secrets has encrypted it again with the current secret. Any other
// format is rejected.

const encoder = new TextEncoder(), decoder = new TextDecoder();
const subtle = () => globalThis.crypto.subtle;
const hkdfSalt = encoder.encode('ServerDesk:v3:keyring');
const encryptionPurpose = 'encrypted-secrets', formatPrefix = 'k1';
const base64urlPattern = /^[A-Za-z0-9_-]+$/;

export const minimumSecretBytes = 32;
export const currentSecretMessage = 'SESSION_SECRET must contain an externally managed secret with at least 32 UTF-8 bytes.';
export const previousSecretMessage = 'SESSION_SECRET_PREVIOUS contains an entry with fewer than 32 UTF-8 bytes.';

const byteLength = value => encoder.encode(value).byteLength;
function base64url(bytes) {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function unbase64url(value) {
  if (!base64urlPattern.test(value)) throw new Error('Invalid ciphertext.');
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), character => character.charCodeAt(0));
}
const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');

async function hkdf(secret, purpose, bits) {
  const material = await subtle().importKey('raw', encoder.encode(secret), 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: hkdfSalt, info: encoder.encode('ServerDesk:v3:' + purpose) }, material, bits));
}

/**
 * 32 key bytes for one purpose: HKDF-SHA-256, IKM = secret, fixed salt
 * 'ServerDesk:v3:keyring', info 'ServerDesk:v3:' + purpose.
 * @param {string} secret
 * @param {string} purpose
 * @returns {Promise<Uint8Array<ArrayBuffer>>}
 */
export function deriveKeyBytes(secret, purpose) {
  return hkdf(secret, purpose, 256);
}

/**
 * The public name of a secret: 16 hex characters (HKDF purpose 'key-id', 8 bytes).
 * @param {string} secret
 * @returns {Promise<string>}
 */
export async function keyId(secret) {
  return hex(await hkdf(secret, 'key-id', 64));
}

/**
 * Trimmed, non-empty entries of SESSION_SECRET_PREVIOUS (comma-separated).
 * @param {unknown} value
 * @returns {string[]}
 */
export function previousSecrets(value) {
  return typeof value === 'string' ? value.split(',').map(entry => entry.trim()).filter(Boolean) : [];
}

const aesKey = bytes => subtle().importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);

/**
 * One secret of the ring. The secret itself stays in this closure; the entry
 * only gives out its kid and the derived keys, each computed once.
 * @param {string} secret
 */
function keyEntry(secret) {
  /** @type {Promise<string>|undefined} */ let kid;
  /** @type {Promise<CryptoKey>|undefined} */ let key;
  return Object.freeze({
    keyId: () => kid ??= keyId(secret),
    key: () => key ??= deriveKeyBytes(secret, encryptionPurpose).then(aesKey),
  });
}

/** @typedef {ReturnType<typeof keyEntry>} KeyEntry */
/** @typedef {{ current: KeyEntry, previous: readonly KeyEntry[] }} Keyring */

/**
 * The current key comes from SESSION_SECRET, previous keys from the optional
 * SESSION_SECRET_PREVIOUS. Throws when a secret has fewer than 32 UTF-8 bytes.
 * @param {{ SESSION_SECRET?: unknown, SESSION_SECRET_PREVIOUS?: unknown }} env
 * @returns {Keyring}
 */
export function createKeyring(env) {
  const current = env?.SESSION_SECRET;
  if (typeof current !== 'string' || byteLength(current) < minimumSecretBytes) throw new Error(currentSecretMessage);
  const previous = [...new Set(previousSecrets(env?.SESSION_SECRET_PREVIOUS))].filter(secret => secret !== current);
  if (previous.some(secret => byteLength(secret) < minimumSecretBytes)) throw new Error(previousSecretMessage);
  return Object.freeze({ current: keyEntry(current), previous: Object.freeze(previous.map(keyEntry)) });
}

function parse(value) {
  const parts = typeof value === 'string' ? value.split('.') : [];
  if (parts.length === 4 && parts[0] === formatPrefix && /^[0-9a-f]{16}$/.test(parts[1])) return { kid: parts[1], iv: parts[2], data: parts[3] };
  return null;
}

async function decrypt(key, iv, data, context) {
  const nonce = unbase64url(iv);
  if (nonce.byteLength !== 12) throw new Error('Invalid ciphertext.');
  return decoder.decode(await subtle().decrypt({ name: 'AES-GCM', iv: nonce, additionalData: encoder.encode(context) }, await key, unbase64url(data)));
}

/**
 * AES-256-GCM with the current key, AAD = context: k1.<kid>.<iv>.<data>.
 * @param {Keyring} ring
 * @param {string} value
 * @param {string} context
 * @returns {Promise<string>}
 */
export async function encryptWithKeyring(ring, value, context) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(context) }, await ring.current.key(), encoder.encode(value));
  return [formatPrefix, await ring.current.keyId(), base64url(iv), base64url(new Uint8Array(encrypted))].join('.');
}

/**
 * Selects the key by kid (k1 format). Throws for an unknown kid, a bad format or
 * a failed authentication; the message never names a secret or the value.
 * @param {Keyring} ring
 * @param {string} value
 * @param {string} context
 * @returns {Promise<string>}
 */
export async function decryptWithKeyring(ring, value, context) {
  const parsed = parse(value);
  if (!parsed) throw new Error('Invalid ciphertext.');
  for (const entry of [ring.current, ...ring.previous]) if (await entry.keyId() === parsed.kid) return decrypt(entry.key(), parsed.iv, parsed.data, context);
  throw new Error('Unknown key.');
}

/**
 * True for every value that is not in the k1 format with the current kid:
 * values under a previous kid and values in any other format (those then fail
 * to decrypt and count as failed in rewrap-secrets).
 * @param {Keyring} ring
 * @param {string} value
 * @returns {Promise<boolean>}
 */
export async function needsRewrap(ring, value) {
  const parsed = parse(value);
  return parsed?.kid !== await ring.current.keyId();
}
