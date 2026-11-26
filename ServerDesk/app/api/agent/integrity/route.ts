import {failure} from '@/lib/server/context';
import {ingestAgentIntegrity} from '@/lib/server/agent/agent-integrity';
// The integrity events of agent 4.18.0 (lib/server/agent/agent-integrity.ts, docs/native-agent-v4.md):
// a stopped, ended, hung, restarted or removed agent and a changed protection.
// The device authenticates from the headers before the body is read.
export async function POST(request:Request){try{return await ingestAgentIntegrity(request);}catch(e){return failure(e);}}
