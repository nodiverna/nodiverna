// Local stand-ins for the fixed hosts of the device assistant
// (lib/server/devices/assistant-provider.ts): one HTTPS server with a test certificate for
// api.anthropic.com and api.openai.com. A handler per host gets {method, path,
// headers, body, json} and returns [status, value] (an object is sent as JSON,
// a string as it is) or 'hang' to never answer. Every request is recorded.
// assistantOptions routes both hosts to the stand-in; the target check stays.
import https from 'node:https';
import {testCertificate} from './test-certificate.mjs';

export const assistantHosts = ['api.anthropic.com', 'api.openai.com'];
export const assistantTls = testCertificate(assistantHosts, {commonName: 'Nodiverna assistant test'});

export async function fakeAssistantProviders() {
  const requests = [], handlers = new Map(), open = new Set();
  const server = https.createServer({key: assistantTls.key, cert: assistantTls.cert}, (request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', async () => {
      const body = Buffer.concat(chunks).toString(), host = String(request.headers.host ?? '').replace(/:\d+$/, '');
      let json = null;
      try { json = body ? JSON.parse(body) : null; } catch { json = null; }
      const entry = {host, method: request.method, path: request.url, headers: request.headers, body, json};
      requests.push(entry);
      const handler = handlers.get(host);
      const result = handler ? await handler(entry, requests.filter(item => item.host === host).length) : [404, {error: 'no handler'}];
      if (result === 'hang') { open.add(response); return; }
      const [status, value] = result;
      const text = typeof value === 'string' ? value : JSON.stringify(value ?? {});
      response.writeHead(status, {'Content-Type': typeof value === 'string' ? 'text/plain' : 'application/json'});
      response.end(text);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port, requests,
    on: (host, handler) => { handlers.set(host, handler); },
    of: host => requests.filter(entry => entry.host === host),
    reset: () => { requests.length = 0; },
    close: () => new Promise(resolve => { for (const response of open) response.destroy(); server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

/** Transport options: both hosts resolve to a public address, the socket opens 127.0.0.1 and port 443 goes to the stand-in. */
export function assistantOptions(port, extra = {}) {
  return {
    ca: [assistantTls.cert],
    resolver: async () => [{address: '93.184.216.34', family: 4}],
    routeAddress: () => '127.0.0.1',
    routePort: (host, original) => assistantHosts.includes(host) ? port : original,
    ...extra,
  };
}
