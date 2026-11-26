// A stand-in for the console's payload worker (ui/shell/console-payload.worker.ts) in Node: a port with the Worker
// methods the client uses (postMessage with transfer, addEventListener, terminate) that runs the real message handler
// of ui/shell/console-payload.ts (in order, as console-payload.worker.ts does) one task later, with structured clone in both directions, as a worker does. `sent`
// lists every message, `emit` fires an event of the worker ('error', 'messageerror', 'message'). While `broken` is true
// (a worker whose script did not load, or that failed), a message gets an error event instead of a reply. `idle()`
// resolves once every reply and event of the messages sent so far has been delivered, so a test can wait for the
// worker instead of counting tasks.
// Loaded after tests/support/register.mjs (the test imports this file dynamically or after the register import).
const {consolePayloadHandler} = await import('../../ui/shell/console-payload.ts');

export function fakePayloadWorker({broken = false} = {}) {
  const listeners = {message: [], error: [], messageerror: []}, handle = consolePayloadHandler(), sent = [], waiting = [];
  let pending = 0;
  const done = () => { if (--pending === 0) for (const resolve of waiting.splice(0)) resolve(); };
  const port = {
    terminated: false,
    broken,
    sent,
    postMessage(message, transfer = []) {
      sent.push({message, transfer});
      pending++;
      if (port.broken) { setTimeout(() => { try { port.emit('error'); } finally { done(); } }, 0); return; }
      const copy = structuredClone(message, {transfer});
      setTimeout(() => {
        handle(copy).then(reply => {
          if (reply && !port.terminated) port.emit('message', {data: structuredClone(reply)});
        }, () => port.emit('message', {data: {type: 'broken'}})).finally(done);
      }, 0);
    },
    idle() { return pending ? new Promise(resolve => waiting.push(resolve)) : Promise.resolve(); },
    addEventListener(type, listener) { listeners[type].push(listener); },
    terminate() { port.terminated = true; },
    emit(type, event = {preventDefault() {}}) { for (const listener of listeners[type]) listener(event); },
  };
  return port;
}
