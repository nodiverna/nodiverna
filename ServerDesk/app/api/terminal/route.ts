import {terminalGet,terminalPost} from '@/lib/server/devices/terminal-sessions';

// SYSTEM terminals of the browser; the logic and its storage are in lib/server/devices/terminal-sessions.ts.
export async function GET(request:Request){return terminalGet(request);}
export async function POST(request:Request){return terminalPost(request);}
