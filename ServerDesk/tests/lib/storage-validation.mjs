// The storage actions (lib/storage-operations.ts): validation, permission classes, native confirmation and
// stable disk and partition targets.
import assert from 'node:assert/strict';
import {storageOperations,isStorageOperation,storageTarget} from '../../lib/storage-operations.ts';

let assertions=0;
const disk={diskNumber:2,diskUniqueId:'scsi-device-123',expectedDiskSizeBytes:107374182400,confirm:true};
const partition={...disk,partitionNumber:1,expectedOffsetBytes:1048576,expectedSizeBytes:53687091200};
const valid=(kind,params)=>{assert.equal(storageOperations[kind].schema.safeParse(params).success,true,kind);assertions++;};
const invalid=(kind,params)=>{assert.equal(storageOperations[kind].schema.safeParse(params).success,false,kind);assertions++;};
valid('storage-inspect',{});
valid('storage-initialize',{...disk,partitionStyle:'GPT'});
valid('storage-set-disk',{...disk,setting:'offline'});
valid('storage-new-volume',{...disk,useMaximumSize:true,fileSystem:'NTFS',label:'Data',driveLetter:'D'});
valid('storage-new-volume',{...disk,useMaximumSize:false,sizeBytes:53687091200,fileSystem:'ReFS',label:''});
valid('storage-resize',{...partition,sizeBytes:64424509440});
valid('storage-drive-letter',{...partition,driveLetter:'E',remove:false});
valid('storage-drive-letter',{...partition,remove:true});
valid('storage-format',{...partition,fileSystem:'NTFS',label:'Data'});
valid('storage-delete-partition',partition);
for(const [kind,operation] of Object.entries(storageOperations)){
 assert.equal(operation.readOnly,kind==='storage-inspect');assertions++;
 if(!operation.readOnly){assert.equal(operation.disruptive,true);assertions++;}
}
invalid('storage-inspect',{script:'Get-Disk'});
for(const [key,value] of [['diskNumber',-1],['diskNumber',1.5],['diskNumber','2'],['diskUniqueId',''],['diskUniqueId','x\n'],['expectedDiskSizeBytes',0],['expectedDiskSizeBytes',Number.MAX_SAFE_INTEGER+1],['confirm',false]])invalid('storage-delete-partition',{...partition,[key]:value});
invalid('storage-delete-partition',{...partition,confirm:undefined});
invalid('storage-delete-partition',{...partition,force:true});
invalid('storage-delete-partition',{...partition,expectedOffsetBytes:-1});
invalid('storage-delete-partition',{...partition,expectedSizeBytes:0});
invalid('storage-delete-partition',{...partition,partitionNumber:0});
invalid('storage-initialize',{...disk,partitionStyle:'dynamic'});
invalid('storage-set-disk',{...disk,setting:'clear'});
invalid('storage-new-volume',{...disk,useMaximumSize:true,sizeBytes:53687091200,fileSystem:'NTFS',label:''});
invalid('storage-new-volume',{...disk,useMaximumSize:false,fileSystem:'NTFS',label:''});
invalid('storage-new-volume',{...disk,useMaximumSize:false,sizeBytes:100,fileSystem:'NTFS',label:''});
invalid('storage-new-volume',{...disk,useMaximumSize:true,fileSystem:'FAT32',label:''});
invalid('storage-new-volume',{...disk,useMaximumSize:true,fileSystem:'NTFS',label:'a:b'});
invalid('storage-new-volume',{...disk,useMaximumSize:true,fileSystem:'NTFS',label:'Data',driveLetter:'C'});
invalid('storage-format',{...partition,fileSystem:'NTFS',label:'x'.repeat(33)});
invalid('storage-drive-letter',{...partition,remove:true,driveLetter:'E'});
invalid('storage-drive-letter',{...partition,remove:false});
assert.equal(isStorageOperation('storage-inspect'),true);assert.equal(isStorageOperation('clear-disk'),false);assert.equal(isStorageOperation({}),false);assertions+=3;
assert.equal(storageTarget('storage-format',partition),'Datenträger 2 / Partition 1');assertions++;
console.log(`PASS: ${assertions} storage validation, permission classification, native confirmation and stable-target parameter assertions.`);
