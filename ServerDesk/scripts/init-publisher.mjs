import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The publisher key of a fork that builds and signs its own Windows agent. It
// creates .data/release-private.pem once and pins its public key for the portal
// (lib/release-publisher.json) and the agent (agent/v3/release-public.pem).
// The portal never reads the private key: pipeline.mjs agent signs releases
// with it through SERVERDESK_RELEASE_KEY_FILE.
const root = fileURLToPath(new URL('../', import.meta.url));
const keyPath = path.join(root, '.data', 'release-private.pem');
await mkdir(path.dirname(keyPath), { recursive: true });
let privateKey;
try { privateKey = await readFile(keyPath, 'utf8'); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  privateKey = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey;
  await writeFile(keyPath, privateKey, { flag: 'wx', mode: 0o600 });
}
const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
const publisherPath = path.join(root, 'lib', 'release-publisher.json');
try {
  const previous = JSON.parse(await readFile(publisherPath, 'utf8'));
  if (previous.publicKey.trim() !== publicKey.trim()) throw new Error('Existing publisher pin differs. Recover its private key; do not silently rotate agent trust.');
} catch (error) { if (error.code !== 'ENOENT') throw error; }
await writeFile(publisherPath, JSON.stringify({ publicKey }, null, 2) + '\n');
await writeFile(path.join(root, 'agent/v3/release-public.pem'), publicKey);
console.log('Publisher public-key SHA256: ' + createHash('sha256').update(publicKey).digest('hex'));
console.log('The private key stays in the ignored file .data/release-private.pem. It signs agent releases: run pipeline.mjs agent with SERVERDESK_RELEASE_KEY_FILE=.data/release-private.pem.');
