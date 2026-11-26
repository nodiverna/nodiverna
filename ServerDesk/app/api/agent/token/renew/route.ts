import {failure,now} from '@/lib/server/context';
import {renewDeviceToken} from '@/lib/server/agent/device-tokens';
export async function POST(request:Request){try{return Response.json(await renewDeviceToken(request),{headers:{'Cache-Control':'no-store','Date':new Date(now()).toUTCString()}});}catch(error){return failure(error);}}
