import {requireViewer,failure} from '@/lib/server/context';
import {nativeAgentDownload} from '@/lib/server/agent/agent-download';
import {requireCan} from '@/lib/server/identity/policy/can';

export async function GET(){try{
 await requireCan(await requireViewer(),'instance.owner');
 return await nativeAgentDownload();
}catch(error){return failure(error);}}
