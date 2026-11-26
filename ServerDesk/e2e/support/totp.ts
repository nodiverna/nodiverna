// TOTP for the e2e owner (RFC 6238, SHA-1, 6 digits, 30-second steps), the same
// calculation as lib/server/identity/mfa.ts. The server accepts the counters current-1 …
// current+1, each only if it is greater than the last counter it accepted, so a
// code is never valid twice. nextTotp() picks the smallest free counter and
// waits for the next window when none is left. It skips current-1 in the last
// seconds of a window: the server's window moves on before the code arrives.
import {createHmac} from 'node:crypto';

export const TOTP_STEP_MS = 30_000;
/** current-1 is only chosen while at least this much of the current window is left. */
export const TOTP_MARGIN_MS = 5_000;
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function decodeBase32(secret: string): Buffer {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of secret.toUpperCase().replace(/[\s=-]/g, '')) {
    const digit = alphabet.indexOf(char);
    if (digit < 0) throw new Error('The TOTP secret is not base32.');
    value = (value << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** The 30-second counter at the given time. */
export function counterAt(nowMs: number): number {
  return Math.floor(nowMs / TOTP_STEP_MS);
}

/** The six-digit code for one counter. */
export function totp(secret: string, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', decodeBase32(secret)).update(message).digest();
  const offset = mac[mac.length - 1] & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

export type CounterChoice = {counter: number; waitMs: 0} | {counter: null; waitMs: number};

/**
 * The smallest counter in current-1 … current+1 that is greater than
 * lastCounter (current-1 only while TOTP_MARGIN_MS of the window is left), or,
 * if there is none, how long to wait for the next window.
 */
export function chooseCounter(lastCounter: number | null, nowMs: number): CounterChoice {
  const current = counterAt(nowMs);
  const late = (current + 1) * TOTP_STEP_MS - nowMs < TOTP_MARGIN_MS;
  for (const counter of late ? [current, current + 1] : [current - 1, current, current + 1]) {
    if (lastCounter === null || counter > lastCounter) return {counter, waitMs: 0};
  }
  return {counter: null, waitMs: (current + 1) * TOTP_STEP_MS - nowMs};
}

/** The next code the server accepts after lastCounter; waits if all counters in the window are used. */
export async function nextTotp(secret: string, lastCounter: number | null, now: () => number = Date.now): Promise<{code: string; counter: number}> {
  for (;;) {
    const choice = chooseCounter(lastCounter, now());
    if (choice.counter !== null) return {code: totp(secret, choice.counter), counter: choice.counter};
    await new Promise(resolve => setTimeout(resolve, choice.waitMs + 50));
  }
}
