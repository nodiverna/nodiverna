import {failure} from '@/lib/server/context';
import {ingestPluginData} from '@/lib/server/extensions/plugin-data';
// The data of an agent plugin (lib/server/extensions/plugin-data.ts, docs/agent-plugins.md): the
// periodic read under the signed plugin policy and the read of a plugin job.
// The device authenticates from the headers before the body is read.
export async function POST(request:Request){try{return await ingestPluginData(request);}catch(e){return failure(e);}}
