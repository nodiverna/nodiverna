import history from '../../agent-changelog-history.json';
import type {AgentChangelogEntry} from '../../agent-update-state';
// The changelog of every agent version in agent/v3/changelogs, newest first,
// written by scripts/agent-changelog-history.mjs (tests/agent/agent-changelogs.mjs
// checks that it is current). The static import bundles it into the
// standalone image. The catalog holds only imported GitHub releases, so this
// list supplies the changes of the versions between the installed and the
// offered agent (agentChangesBetween). Server only: the client gets it from
// GET /api/releases.
export const agentChangelogHistory:AgentChangelogEntry[]=history;
