import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { agentChangelogs } from './agent-release.mjs';

// The changelog history of the portal: every agent/v3/changelogs/*.json,
// validated as for the release notes and newest first, in one JSON file that
// lib/server/agent/agent-changelog-history.ts bundles. The catalog holds only imported
// GitHub releases, so this file supplies the changes of the other versions
// between the installed and the offered agent.
//
// CLI, run in ServerDesk (all paths are relative to the current directory):
//   node scripts/agent-changelog-history.mjs           write the file
//   node scripts/agent-changelog-history.mjs --check   exit 1 when the file is out of date
export const historyFile = 'lib/agent-changelog-history.json';

/** The file content for the changelogs below the directory. */
export function agentChangelogHistory(directory) {
  return JSON.stringify(agentChangelogs(directory), null, 2) + '\n';
}

function read(file) {
  try { return readFileSync(file, 'utf8'); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

function cli(argv) {
  const { values } = parseArgs({ args: argv, options: { check: { type: 'boolean' } } });
  const content = agentChangelogHistory('.');
  if (values.check) {
    if (read(historyFile) === content) return;
    throw new Error(`${historyFile} is out of date. Run node scripts/agent-changelog-history.mjs.`);
  }
  if (read(historyFile) === content) return console.log(`${historyFile} is current.`);
  writeFileSync(historyFile, content);
  console.log(`Wrote ${historyFile}.`);
}

const direct = process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (direct) {
  try { cli(process.argv.slice(2)); } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
