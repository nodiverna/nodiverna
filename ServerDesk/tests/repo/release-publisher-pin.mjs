// The committed publisher pin is the production key, and every anchor encodes
// it: lib/release-publisher.json, agent/v3/release-public.pem, agent/package-v3.ts
// and public/Bootstrap-ServerDesk-V3.ps1. A test pin of scripts/test-publisher.mjs
// that is committed by mistake fails here.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { productionPublisherFingerprint as productionFingerprint, publisherFingerprint } from '../../scripts/test-publisher.mjs';
import { serverDeskRoot } from '../support/paths.mjs';

// The SHA-256 of the DER SubjectPublicKeyInfo of the production publisher key
// has one source, shared with the key refusal of scripts/test-publisher.mjs.
const read = file => readFileSync(serverDeskRoot + file, 'utf8');
const pin = JSON.parse(read('lib/release-publisher.json')).publicKey;
assert.equal(publisherFingerprint(pin), productionFingerprint, 'lib/release-publisher.json pins the production publisher; a test pin must never be committed');
assert.equal(publisherFingerprint(read('agent/v3/release-public.pem')), productionFingerprint, 'agent/v3/release-public.pem is the same key');
const jwk = crypto.createPublicKey(pin).export({ format: 'jwk' });
const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64');
for (const file of ['agent/package-v3.ts', 'public/Bootstrap-ServerDesk-V3.ps1']) {
  const anchors = [...read(file).matchAll(/FromBase64String\((?:\\")?'([A-Za-z0-9+/=]{88})'/g)].map(match => match[1]);
  assert.deepEqual([...new Set(anchors)], [point], `${file} embeds exactly the production anchor`);
}
console.log('PASS release publisher pin: the pin, the agent key and both installer anchors are the production publisher.');
