import {importedReleaseDownload} from '@/lib/server/agent/release-source';
import {failure,HttpError} from '@/lib/server/context';

// The immutable release files contain no registration or device credentials.
// Every path is a file of a stored release (lib/server/agent/release-source.ts): its stored
// chunks in order, also for a disabled release, never for a deleted one. Any
// other path is not found.
export async function GET(_request:Request,context:{params:Promise<{file:string}>}){try{
 const {file}=await context.params,path='/downloads/'+file;
 const imported=await importedReleaseDownload(path);
 if(!imported)throw new HttpError('apiError.download.fileNotFound');
 return imported;
}catch(error){return failure(error);}}
