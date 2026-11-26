import {requireDevice,type Permission} from '../identity/access';
import {privilegedFilePath} from '../../file-operations';
import type {Viewer} from '../../types';

// The path rules are pure and live in file-operations, where job requirements use them.
export {privilegedFilePath,fileManagementAccess} from '../../file-operations';

export async function requireFileAccess(viewer:Viewer,serverId:string,path:string,permission:Permission){
 await requireDevice(viewer,serverId,permission);
 if(privilegedFilePath(path))await requireDevice(viewer,serverId,'manage');
}
