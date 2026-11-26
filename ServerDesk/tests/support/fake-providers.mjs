// Local stand-ins for the fixed hosts of the modern email sign-ins
// (lib/server/notifications/notify/oauth.ts, lib/server/notifications/notify/graph.ts): one HTTPS server with a test
// certificate for login.microsoftonline.com, graph.microsoft.com,
// oauth2.googleapis.com and smtp.gmail.com. It answers per host name with a
// handler and records every request. providerOptions routes the fixed hosts and
// ports (443, 465) to the local servers; the target check itself stays as it is.
// serviceAccountKeyFile makes a Google service account key file with a fresh RSA
// key pair, so no private key is stored in the repository.
import https from 'node:https';
import {generateKeyPairSync, randomBytes} from 'node:crypto';
import {testCertificate, testTls} from './test-certificate.mjs';

export const providerHosts = ['login.microsoftonline.com', 'graph.microsoft.com', 'oauth2.googleapis.com', 'smtp.gmail.com'];
/** One certificate for the four provider hosts; the clients trust it next to the shared test certificate. */
export const providerTls = testCertificate(providerHosts, {commonName: 'Nodiverna provider test'});

/**
 * The HTTPS stand-in. `on(host, handler)` sets the answer of a host: the handler
 * gets {path, headers, body, form} and returns [status, value]; an object value
 * is sent as JSON, a string as it is.
 */
export async function fakeProviders() {
  const requests = [], handlers = new Map();
  const server = https.createServer({key: providerTls.key, cert: providerTls.cert}, (request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', async () => {
      const body = Buffer.concat(chunks).toString(), host = String(request.headers.host ?? '').replace(/:\d+$/, '');
      const entry = {host, path: request.url, headers: request.headers, body, form: Object.fromEntries(new URLSearchParams(body))};
      requests.push(entry);
      const handler = handlers.get(host);
      const [status, value] = handler ? await handler(entry) : [404, {error: 'no handler'}];
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
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
}

/**
 * Transport options for the tests: every host resolves to a public address, the
 * socket opens 127.0.0.1, port 443 goes to the HTTPS stand-in and port 465 of
 * smtp.gmail.com to `smtpPort`. Both test certificates are trusted.
 */
export function providerOptions({httpsPort, smtpPort = 0, ...extra}) {
  return {
    ca: [testTls.cert, providerTls.cert],
    resolver: async () => [{address: '93.184.216.34', family: 4}],
    routeAddress: () => '127.0.0.1',
    routePort: (host, port) => providerHosts.includes(host) ? (host === 'smtp.gmail.com' ? smtpPort : httpsPort) : port,
    ...extra,
  };
}

/** A Google service account key file (JSON text) with a new RSA key pair, and the public key to check signatures. */
export function serviceAccountKeyFile({clientEmail = 'alerts-mailer@project-1.iam.gserviceaccount.com', type = 'service_account', keyType = 'rsa'} = {}) {
  const pair = keyType === 'rsa' ? generateKeyPairSync('rsa', {modulusLength: 2048}) : generateKeyPairSync('ec', {namedCurve: 'P-256'});
  const privateKeyId = randomBytes(20).toString('hex');
  const privateKey = pair.privateKey.export({type: 'pkcs8', format: 'pem'});
  const file = {type, project_id: 'project-1', private_key_id: privateKeyId, private_key: privateKey, client_email: clientEmail, client_id: '104211234567890123456',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth', token_uri: 'https://evil.example.test/token'};
  return {text: JSON.stringify(file, null, 2), file, privateKey, privateKeyId, clientEmail, publicKey: pair.publicKey};
}
