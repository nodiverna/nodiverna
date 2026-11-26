// Pin and unpin a device (docs/device-workspace.md, "Pinned devices"): the console keeps the pinned set of the account,
// changes it at once (optimistic) and then sends PUT /api/account/pinned-devices. Success takes the list the server
// answers and confirms with a toast; a failure restores the set from before the toggle and shows the error. One request
// runs at a time per device: a second toggle of the same device waits for the first one. Framework free, so the
// console (ui/shell/console.tsx) and the tests drive the same code.
import {credentialFetch,readApiJson} from '@/ui/base/api';

/** PUT /api/account/pinned-devices: pins or unpins one device of the own account. Resolves with the visible pins. */
export async function saveDevicePin(deviceId:string,pinned:boolean):Promise<string[]>{
 const response=await credentialFetch('/api/account/pinned-devices',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({deviceId,pinned}),cache:'no-store'});
 return (await readApiJson<{pinnedDeviceIds:string[]}>(response)).pinnedDeviceIds;
}

export type PinToggleOptions={
 /** The pinned set the console shows now. */
 read:()=>readonly string[];
 /** Shows a new pinned set. */
 write:(ids:readonly string[])=>void;
 save?:(deviceId:string,pinned:boolean)=>Promise<string[]>;
 /** Feedback: success with the state the device has now, failure with the error. */
 done:(pinned:boolean)=>void;
 failed:(failure:unknown)=>void;
};

/** The pin toggle of the console. toggle(id) resolves when its request settled (tests wait on it). */
export function pinToggle({read,write,save=saveDevicePin,done,failed}:PinToggleOptions){
 const queue=new Map<string,Promise<void>>();
 return {
  toggle(deviceId:string):Promise<void>{
   const before=[...read()],pinned=!before.includes(deviceId);
   write(pinned?[...before,deviceId]:before.filter(id=>id!==deviceId));
   const run=(queue.get(deviceId)??Promise.resolve()).then(()=>save(deviceId,pinned)).then(
    ids=>{write(ids);done(pinned);},
    failure=>{write(before);failed(failure);});
   queue.set(deviceId,run);
   void run.then(()=>{if(queue.get(deviceId)===run)queue.delete(deviceId);});
   return run;
  },
 };
}
