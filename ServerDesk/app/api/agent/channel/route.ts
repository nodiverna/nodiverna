import {agentChannel} from '@/lib/server/agent/agent-channel';

// The agent command channel; the logic and its storage are in lib/server/agent/agent-channel.ts.
export async function POST(request:Request){return agentChannel(request);}
