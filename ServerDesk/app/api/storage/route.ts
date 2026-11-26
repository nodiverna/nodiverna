import {agentResultFields} from '@/lib/agent-messages';
import {failure,guid,HttpError,requireViewer} from '@/lib/server/context';
import {requireDevice} from '@/lib/server/identity/access';
import {storageOperations,isStorageOperation} from '@/lib/storage-operations';
import {storageJobs} from '@/lib/server/devices/storage-jobs';

// Mutations use the console's existing MFA, confirmation, mode and encrypted
// agent channel. This endpoint exposes only scoped storage job results.
export async function GET(request:Request){try{
 const v=await requireViewer(),url=new URL(request.url),serverId=url.searchParams.get('serverId'),jobId=url.searchParams.get('jobId');
 if(!guid(serverId)||jobId&&!guid(jobId))throw new HttpError('apiError.files.invalidDeviceOrJob');
 await requireDevice(v,serverId,'diagnose');
 const rows=await storageJobs(serverId,jobId);
 const jobs=[];
 for(const row of rows){
  if(!isStorageOperation(row.kind))continue;
  if(!storageOperations[row.kind].readOnly){try{await requireDevice(v,serverId,'manage');}catch(e){if(jobId||!(e instanceof HttpError)||e.status!==403)throw e;continue;}}
  let data:unknown=null;try{data=row.data?JSON.parse(row.data):null;}catch{}
  const {result_code,result_args,...job}=row;
  jobs.push({...job,...agentResultFields({result_code,result_args}),data});
 }
 return Response.json({jobs},{headers:{'Cache-Control':'no-store'}});
}catch(e){return failure(e);}}
