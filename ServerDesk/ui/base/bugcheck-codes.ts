// Windows bug check (stop) codes: the names of the common codes, the short form
// for the UI and the link to the Microsoft documentation of a code. Pure, so the
// console, the demo data and the tests share it.

/** The common stop codes with their symbolic names, ordered by code. */
const names:ReadonlyMap<number,string>=new Map([
 [0x01,'APC_INDEX_MISMATCH'],
 [0x0A,'IRQL_NOT_LESS_OR_EQUAL'],
 [0x19,'BAD_POOL_HEADER'],
 [0x1A,'MEMORY_MANAGEMENT'],
 [0x1E,'KMODE_EXCEPTION_NOT_HANDLED'],
 [0x24,'NTFS_FILE_SYSTEM'],
 [0x2E,'DATA_BUS_ERROR'],
 [0x3B,'SYSTEM_SERVICE_EXCEPTION'],
 [0x3D,'INTERRUPT_EXCEPTION_NOT_HANDLED'],
 [0x44,'MULTIPLE_IRP_COMPLETE_REQUESTS'],
 [0x4A,'IRQL_GT_ZERO_AT_SYSTEM_SERVICE'],
 [0x4E,'PFN_LIST_CORRUPT'],
 [0x50,'PAGE_FAULT_IN_NONPAGED_AREA'],
 [0x51,'REGISTRY_ERROR'],
 [0x5C,'HAL_INITIALIZATION_FAILED'],
 [0x77,'KERNEL_STACK_INPAGE_ERROR'],
 [0x7A,'KERNEL_DATA_INPAGE_ERROR'],
 [0x7B,'INACCESSIBLE_BOOT_DEVICE'],
 [0x7E,'SYSTEM_THREAD_EXCEPTION_NOT_HANDLED'],
 [0x7F,'UNEXPECTED_KERNEL_MODE_TRAP'],
 [0x8E,'KERNEL_MODE_EXCEPTION_NOT_HANDLED'],
 [0x9C,'MACHINE_CHECK_EXCEPTION'],
 [0x9F,'DRIVER_POWER_STATE_FAILURE'],
 [0xA0,'INTERNAL_POWER_ERROR'],
 [0xBE,'ATTEMPTED_WRITE_TO_READONLY_MEMORY'],
 [0xC1,'SPECIAL_POOL_DETECTED_MEMORY_CORRUPTION'],
 [0xC2,'BAD_POOL_CALLER'],
 [0xC4,'DRIVER_VERIFIER_DETECTED_VIOLATION'],
 [0xC5,'DRIVER_CORRUPTED_EXPOOL'],
 [0xC7,'TIMER_OR_DPC_INVALID'],
 [0xCE,'DRIVER_UNLOADED_WITHOUT_CANCELLING_PENDING_OPERATIONS'],
 [0xD1,'DRIVER_IRQL_NOT_LESS_OR_EQUAL'],
 [0xD5,'DRIVER_PAGE_FAULT_IN_FREED_SPECIAL_POOL'],
 [0xD8,'DRIVER_USED_EXCESSIVE_PTES'],
 [0xE2,'MANUALLY_INITIATED_CRASH'],
 [0xEA,'THREAD_STUCK_IN_DEVICE_DRIVER'],
 [0xED,'UNMOUNTABLE_BOOT_VOLUME'],
 [0xEF,'CRITICAL_PROCESS_DIED'],
 [0xF4,'CRITICAL_OBJECT_TERMINATION'],
 [0xF5,'FLTMGR_FILE_SYSTEM'],
 [0xF7,'DRIVER_OVERRAN_STACK_BUFFER'],
 [0xFC,'ATTEMPTED_EXECUTE_OF_NOEXECUTE_MEMORY'],
 [0xFE,'BUGCODE_USB_DRIVER'],
 [0x101,'CLOCK_WATCHDOG_TIMEOUT'],
 [0x109,'CRITICAL_STRUCTURE_CORRUPTION'],
 [0x10D,'WDF_VIOLATION'],
 [0x113,'VIDEO_DXGKRNL_FATAL_ERROR'],
 [0x116,'VIDEO_TDR_FAILURE'],
 [0x117,'VIDEO_TDR_TIMEOUT_DETECTED'],
 [0x119,'VIDEO_SCHEDULER_INTERNAL_ERROR'],
 [0x124,'WHEA_UNCORRECTABLE_ERROR'],
 [0x127,'PAGE_NOT_ZERO'],
 [0x133,'DPC_WATCHDOG_VIOLATION'],
 [0x139,'KERNEL_SECURITY_CHECK_FAILURE'],
 [0x13A,'KERNEL_MODE_HEAP_CORRUPTION'],
 [0x141,'VIDEO_ENGINE_TIMEOUT_DETECTED'],
 [0x144,'BUGCODE_USB3_DRIVER'],
 [0x14F,'PDC_WATCHDOG_TIMEOUT'],
 [0x154,'UNEXPECTED_STORE_EXCEPTION'],
 [0x157,'KERNEL_THREAD_PRIORITY_FLOOR_VIOLATION'],
 [0x189,'BAD_OBJECT_HEADER'],
 [0x18B,'SECURE_KERNEL_ERROR'],
 [0x1C8,'MANUALLY_INITIATED_POWER_BUTTON_HOLD'],
 [0x1CA,'SYNTHETIC_WATCHDOG_TIMEOUT'],
]);
/** The number of named codes, for the tests. */
export const bugCheckNameCount=names.size;
const docsBase='https://learn.microsoft.com/windows-hardware/drivers/debugger/';
/** The bug check code reference of Microsoft, for codes without a name here. */
export const bugCheckReferenceUrl=docsBase+'bug-check-code-reference2';
const valid=(code:number)=>Number.isInteger(code)&&code>=0&&code<=0xFFFFFFFF;

/** The symbolic name of a stop code, or null when it is not in the list. */
export function bugCheckName(code:number):string|null{return valid(code)?names.get(code)??null:null;}
/** "0x3B SYSTEM_SERVICE_EXCEPTION"; "0x1234ABCD" for a code without a name (upper-case hex, no padding). */
export function formatStopCode(code:number):string{
 const hex='0x'+(valid(code)?code:0).toString(16).toUpperCase(),name=bugCheckName(code);
 return name?`${hex} ${name}`:hex;
}
/** The Microsoft page of a stop code (lower-case hex, the name in lower case with "-"); the code reference for an unknown code. */
export function bugCheckDocUrl(code:number):string{
 const name=bugCheckName(code);
 if(!name)return bugCheckReferenceUrl;
 return `${docsBase}bug-check-0x${code.toString(16)}--${name.toLowerCase().replaceAll('_','-')}`;
}
