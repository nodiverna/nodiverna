import {db,sql} from '../db';
import {storageOperations} from '../../storage-operations';

export type StorageJobRow={id:string;kind:string;state:string;createdAt:number;result:string|null;result_code:string|null;result_args:string|null;data:string|null};
/** The 20 newest storage jobs of a device (or the one with jobId), with their agent output. */
export async function storageJobs(serverId:string,jobId:string|null){
 return db().query<StorageJobRow>(sql`SELECT j.id,j.action AS kind,j.state,j.created_at AS "createdAt",j.result,j.result_code,j.result_args,o.data FROM jobs j LEFT JOIN job_outputs o ON o.job_id=j.id AND o.server_id=j.server_id WHERE j.server_id=${serverId} AND j.action IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify(Object.keys(storageOperations))}::jsonb)) ${jobId?sql`AND j.id=${jobId}`:sql``} ORDER BY j.created_at DESC LIMIT 20`);
}
