// The console's payload worker: a dedicated worker per mounted console (ui/shell/console-payload-client.ts). It reads
// each refresh answer (a Blob), parses it and diffs it against its copy of the shown data, off the main thread
// (consolePayloadHandler in ui/shell/console-payload.ts). Worker scope only: no DOM, no React.
import {consolePayloadHandler,type PayloadRequest} from '@/ui/shell/console-payload';

// The dedicated worker scope, typed without the webworker lib (the project compiles with the DOM lib).
const scope=globalThis as unknown as {
 onmessage:((event:MessageEvent<PayloadRequest>)=>void)|null;
 onmessageerror:(()=>void)|null;
 postMessage(message:unknown):void;
};
const handle=consolePayloadHandler();
// The handler keeps the order of the messages; a failure inside it would leave its request waiting, so it fails the worker.
scope.onmessage=event=>{handle(event.data).then(reply=>{if(reply)scope.postMessage(reply);},()=>scope.postMessage({type:'broken'}));};
// A message that cannot be read here would leave its request waiting: the client treats the worker as failed.
scope.onmessageerror=()=>scope.postMessage({type:'broken'});
