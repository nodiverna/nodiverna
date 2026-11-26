// Sizes in Management → Storage (ui/devices/management/storage-size.ts): bounds, units, conversion and validation.
import '../../support/register.mjs';
import assert from 'node:assert/strict';
const {STORAGE_MIB:MiB,storageSizeBounds,storageSizeInput,storageSizeDefaultUnit,storageSizeMiB,parseStorageSize}=await import('../../../ui/devices/management/storage-size.ts');
const GiB=1024*MiB;
let checks=0;
const check=(actual,expected)=>{assert.deepEqual(actual,expected);checks++;};

// Screenshot regression: the previous editor filled the unchanged 31.447...
// GiB volume into an input requiring at least the next byte of growth.
const currentBytes=Math.round(31.4472498937738*GiB);
const growth=storageSizeBounds({minBytes:currentBytes-4,maxBytes:64*GiB-511,currentBytes,growOnly:true});
check(growth.minMiB,Math.ceil((currentBytes+1)/MiB));
check(growth.maxMiB,Math.floor((64*GiB-511)/MiB));
check(growth.defaultMiB,63*1024);
check(storageSizeInput(growth.defaultMiB,'GiB'),'63');
check(storageSizeDefaultUnit(growth.defaultMiB),'GiB');
check(parseStorageSize('63','GiB',growth),{ok:true,bytes:63*GiB});
check(parseStorageSize(String(currentBytes/GiB),'GiB',growth).ok,false);
check(parseStorageSize('64','GiB',growth).ok,false);

const smallGrowth=storageSizeBounds({minBytes:currentBytes,maxBytes:currentBytes+50*MiB+123,currentBytes,growOnly:true});
check(smallGrowth.defaultMiB,smallGrowth.maxMiB);
check(storageSizeDefaultUnit(smallGrowth.defaultMiB),'MiB');
check(parseStorageSize(storageSizeInput(smallGrowth.defaultMiB,'MiB'),'MiB',smallGrowth).ok,true);
check(parseStorageSize(String(Math.floor(currentBytes/MiB)),'MiB',smallGrowth).ok,false);
check(smallGrowth.minMiB*MiB>currentBytes,true);
check(smallGrowth.maxMiB*MiB<=currentBytes+50*MiB+123,true);

// Exactly inclusive, one-byte boundaries and a disk too small for a rounded
// MiB growth all preserve the native range instead of rounding outside it.
check(storageSizeBounds({minBytes:32*GiB,maxBytes:32*GiB,currentBytes:31*GiB,growOnly:true}),{minMiB:32768,maxMiB:32768,defaultMiB:32768,currentBytes:31*GiB});
check(storageSizeBounds({minBytes:32*GiB,maxBytes:32*GiB,currentBytes:32*GiB,growOnly:true}),null);
check(storageSizeBounds({minBytes:currentBytes,maxBytes:Math.ceil(currentBytes/MiB)*MiB-1,currentBytes,growOnly:true}),null);
check(storageSizeBounds({minBytes:20*MiB+1,maxBytes:21*MiB-1}),null);
check(storageSizeBounds({minBytes:16*MiB,maxBytes:16*MiB}),{minMiB:16,maxMiB:16,defaultMiB:16});
check(storageSizeBounds({minBytes:0,maxBytes:15*MiB}),null);
check(storageSizeBounds({minBytes:NaN,maxBytes:32*GiB}),null);
check(storageSizeBounds({minBytes:16*MiB,maxBytes:Number.MAX_SAFE_INTEGER+1}),null);
check(storageSizeBounds({minBytes:16*MiB,maxBytes:32*GiB,currentBytes:Number.MAX_SAFE_INTEGER,growOnly:true}),null);

const newVolume=storageSizeBounds({minBytes:16*MiB,maxBytes:100*GiB-1});
check(newVolume.defaultMiB,99*1024);
check(parseStorageSize(storageSizeInput(newVolume.maxMiB,'MiB'),'MiB',newVolume),{ok:true,bytes:100*GiB-MiB});
check(storageSizeMiB('32.5','GiB'),33280);
check(storageSizeMiB('32.25','GiB'),33024);
check(storageSizeMiB('32.0009765625','GiB'),32769);
check(storageSizeInput(32769,'GiB'),'32.0009765625');
check(storageSizeMiB(storageSizeInput(32769,'GiB'),'GiB'),32769);
for(const value of ['',' ','-1','NaN','Infinity','1e3','0x20','0.1','1.1','32,5'])check(storageSizeMiB(value,'MiB'),null);
check(storageSizeMiB('32.1','GiB'),null);
check(parseStorageSize('32','GiB',null).ok,false);
const unchanged=storageSizeBounds({minBytes:20*GiB,maxBytes:60*GiB,currentBytes:40*GiB});
check(parseStorageSize('40','GiB',unchanged).ok,false);
check(parseStorageSize('30','GiB',unchanged),{ok:true,bytes:30*GiB});
console.log(`PASS: ${checks} storage size bounds, screenshot regression, unit conversion and validation assertions.`);
