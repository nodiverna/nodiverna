import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { writeFile, access, readFile } from 'node:fs/promises';

const filename = '.env.local';
// ECDSA P-256 key the portal signs agent work with. Single-line PKCS#8 DER in
// base64 so it fits every env file; agents pin its public key at installation.
const jobSigningKey = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1', privateKeyEncoding: { type: 'pkcs8', format: 'der' }, publicKeyEncoding: { type: 'spki', format: 'der' } }).privateKey.toString('base64');
// The password of the local PostgreSQL container (pnpm db:local up).
const databasePassword = () => randomBytes(24).toString('hex');
try {
  await access(filename);
  const contents = await readFile(filename, 'utf8');
  const added = [];
  if (!/^AGENT_JOB_SIGNING_KEY(?:_FILE)?=./m.test(contents)) added.push(`AGENT_JOB_SIGNING_KEY=${jobSigningKey()}`);
  if (!/^DATABASE_PASSWORD=./m.test(contents)) added.push(`DATABASE_PASSWORD=${databasePassword()}`);
  if (!added.length) console.log(`${filename} already exists; left unchanged.`);
  else {
    await writeFile(filename, contents.trimEnd() + '\n' + added.join('\n') + '\n');
    const names = added.map(line => line.slice(0, line.indexOf('=')));
    console.log(`${filename} already exists; added ${names.join(' and ')}.${names.includes('AGENT_JOB_SIGNING_KEY') ? ' Reinstall agents with a fresh registration.' : ''}`);
  }
}
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const contents = [
    'SITE_ORIGIN=https://localhost:3000',
    `SESSION_SECRET=${randomBytes(48).toString('base64url')}`,
    `PASSWORD_PEPPER=${randomBytes(48).toString('base64url')}`,
    `AGENT_JOB_SIGNING_KEY=${jobSigningKey()}`,
    'DATABASE_URL=postgres://serverdesk@127.0.0.1:5432/serverdesk',
    `DATABASE_PASSWORD=${databasePassword()}`,
    'OBJECT_STORAGE_DRIVER=filesystem',
    'OBJECT_STORAGE_PATH=.data/objects',
    '',
  ].join('\n');
  await writeFile(filename, contents, { flag: 'wx', mode: 0o600 });
  console.log(`Created ${filename} with fresh local secrets. Next: pnpm db:local up, then pnpm db:migrate`);
}
