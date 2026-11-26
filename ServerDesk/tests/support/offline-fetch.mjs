// The tests never reach the internet. Importing this module (or preloading it
// with --import for a CLI child process) replaces globalThis.fetch: requests to
// this machine (localhost, 127.0.0.1, [::1]) go through, every other request
// fails like a network without a route. A maintenance run then reports the
// agent release check as failed with the reason unreachable, the same in every
// environment, instead of asking api.github.com.
const local = new Set(['localhost', '127.0.0.1', '[::1]']);
const original = globalThis.fetch;
export const offlineFetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (local.has(url.hostname)) return original(input, init);
  throw new TypeError('fetch failed', { cause: new Error('The tests have no network access.') });
};
globalThis.fetch = offlineFetch;
