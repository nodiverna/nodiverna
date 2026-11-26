#!/usr/bin/env node
/**
 * The PostgreSQL container for native local development:
 *
 *   pnpm db:local up|down|status
 *
 * Runs serverdesk-local-db (postgres:17-alpine) with the named volume
 * serverdesk-local-db-data. The port is published only on 127.0.0.1 (the port
 * of DATABASE_URL in .env.local, default 5432) and the password comes from
 * DATABASE_PASSWORD in .env.local (pnpm setup writes it). It reaches Docker
 * through the environment, never as a command-line argument. `down` stops and
 * removes the container and keeps the volume with the data.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const container = 'serverdesk-local-db';
export const volume = 'serverdesk-local-db-data';
export const image = 'postgres:17-alpine';

export function readEnvFile(file = '.env.local') {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) values[match[1]] = match[2];
  }
  return values;
}

/** The docker run arguments; the password is passed by name only (-e POSTGRES_PASSWORD). */
export function runArguments(port = 5432) {
  return ['run', '-d', '--name', container, '--restart', 'unless-stopped',
    '-e', 'POSTGRES_USER=serverdesk', '-e', 'POSTGRES_DB=serverdesk', '-e', 'POSTGRES_PASSWORD',
    '-v', `${volume}:/var/lib/postgresql/data`, '-p', `127.0.0.1:${port}:5432`, image];
}

function docker(args, env = process.env) {
  return spawnSync('docker', args, { encoding: 'utf8', env, windowsHide: true });
}

function state() {
  const inspect = docker(['inspect', '--format', '{{.State.Status}}', container]);
  return inspect.status === 0 ? inspect.stdout.trim() : 'absent';
}

export function main(command = process.argv[2]) {
  if (command === 'status') { console.log(`${container}: ${state()}`); return 0; }
  if (command === 'down') {
    if (state() === 'absent') { console.log(`${container} is not there. The volume ${volume} stays.`); return 0; }
    const removed = docker(['rm', '-f', container]);
    if (removed.status !== 0) { console.error(removed.stderr.trim()); return 1; }
    console.log(`${container} removed. The data stays in the volume ${volume}.`);
    return 0;
  }
  if (command === 'up') {
    const current = state();
    if (current === 'running') { console.log(`${container} is already running.`); return 0; }
    if (current !== 'absent') {
      const started = docker(['start', container]);
      if (started.status !== 0) { console.error(started.stderr.trim()); return 1; }
      console.log(`${container} started.`);
      return 0;
    }
    const env = readEnvFile();
    if (!env.DATABASE_PASSWORD) { console.error('DATABASE_PASSWORD is missing in .env.local. Run pnpm setup first.'); return 1; }
    let port = 5432;
    try { port = Number(new URL(env.DATABASE_URL).port || 5432); } catch { /* the default port */ }
    const created = docker(runArguments(port), { ...process.env, POSTGRES_PASSWORD: env.DATABASE_PASSWORD });
    if (created.status !== 0) { console.error(created.stderr.trim()); return 1; }
    console.log(`${container} runs on 127.0.0.1:${port}. Next: pnpm db:migrate`);
    return 0;
  }
  console.error('Usage: pnpm db:local up|down|status');
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
