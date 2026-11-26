import { cp } from 'node:fs/promises';
import path from 'node:path';

// Next traces executable dependencies. Public files and browser assets are
// copied explicitly, just as the Docker runtime stage does.
export async function prepareStandalone() {
  await cp('public', '.next/standalone/public', { recursive: true, force: true });
  await cp('.next/static', '.next/standalone/.next/static', { recursive: true, force: true });
}

export function absoluteRuntimePaths(configuration = process.env) {
  const result = { ...configuration };
  if (result.DATABASE_URL?.startsWith('file:') && !result.DATABASE_URL.startsWith('file://')) {
    result.DATABASE_URL = 'file:' + path.resolve(result.DATABASE_URL.slice(5)).replaceAll('\\', '/');
  }
  for (const key of ['OBJECT_STORAGE_PATH', 'AGENT_JOB_SIGNING_KEY_FILE']) if (result[key]) result[key] = path.resolve(result[key]);
  return result;
}
