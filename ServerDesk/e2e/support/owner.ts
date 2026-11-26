// The e2e owner of one installation: e2e/.auth/owner.json holds the base URL,
// username, password, TOTP secret and the last TOTP counter used. It contains
// credentials of the test installation and is never shared (.gitignore).
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export type Owner = {baseUrl: string; username: string; password: string; secret: string; lastCounter: number | null};

export const OWNER_USERNAME = 'e2e-owner';
export const e2eDir = fileURLToPath(new URL('..', import.meta.url));
export const authDir = path.join(e2eDir, '.auth');
export const artifactsDir = path.join(e2eDir, 'artifacts');
const ownerFile = path.join(authDir, 'owner.json');

/** BASE_URL as given; scripts/e2e.mjs has checked it. */
export function baseUrl(): string {
  const value = process.env.BASE_URL;
  if (!value) throw new Error('BASE_URL is not set. Start an installation and run: BASE_URL=https://localhost:<port> pnpm test:e2e');
  return value;
}

export const originOf = (url: string): string | null => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

/** The stored owner if it belongs to this BASE_URL. */
export function readOwner(url = baseUrl()): Owner | null {
  if (!existsSync(ownerFile)) return null;
  const owner = JSON.parse(readFileSync(ownerFile, 'utf8')) as Owner;
  return owner.baseUrl === originOf(url) ? owner : null;
}

export function writeOwner(owner: Owner): void {
  mkdirSync(authDir, {recursive: true});
  writeFileSync(ownerFile, JSON.stringify(owner, null, 2) + '\n', {mode: 0o600});
}

/** The stored owner for this BASE_URL; the setup step has created it. */
export function requireOwner(): Owner {
  const owner = readOwner();
  if (!owner) throw new Error(`e2e/.auth/owner.json does not exist for ${baseUrl()}. The setup step should have created it.`);
  return owner;
}

/** Storage state after the login of one project, for the later paths of that project. */
export const stateFile = (project: string): string => path.join(authDir, `${project}.json`);
