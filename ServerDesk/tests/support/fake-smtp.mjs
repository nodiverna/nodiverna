// A small SMTP server for the notification tests (node:net and node:tls): EHLO,
// optional STARTTLS or implicit TLS with the test certificate
// (tests/support/test-certificate.mjs) or another certificate, AUTH PLAIN, LOGIN
// and XOAUTH2 (it records the decoded XOAUTH2 strings), a custom reply line for a
// refused sign-in, MAIL, RCPT with rejected recipients, DATA and QUIT. It records
// the messages it accepted.
import net from 'node:net';
import tls from 'node:tls';
import {testTls} from './test-certificate.mjs';

/**
 * `oauth` accepts XOAUTH2 for that user and token. `authFailure` replaces the
 * reply line of every refused sign-in, for example
 * "535 5.7.139 Authentication unsuccessful, basic authentication is disabled.".
 * `tls` is the server certificate (default: the shared test certificate).
 * @param {{starttls?: boolean, implicitTls?: boolean, auth?: {user: string, pass: string} | null, oauth?: {user: string, token: string} | null, authFailure?: string, rejectRecipients?: string[], rejectCode?: number, tls?: {key: string, cert: string} | null}} options
 */
export async function fakeSmtp({ starttls = true, implicitTls = false, auth = null, oauth = null, authFailure = '535 5.7.8 Authentication failed', rejectRecipients = [], rejectCode = 550, tls: serverTls = null } = {}) {
  const messages = [], sessions = [], xoauth2 = [];
  const certificate = () => serverTls ?? { key: testTls.key, cert: testTls.cert };
  const mechanisms = [auth && 'PLAIN LOGIN', oauth && 'XOAUTH2'].filter(Boolean).join(' ');
  const handle = (initial, secure) => {
    const session = { secure, authenticated: null, from: null, to: [] };
    sessions.push(session);
    let socket = initial, buffer = '', data = null, login = null;
    const send = line => socket.write(line + '\r\n');
    const lineHandler = line => {
      if (data !== null) {
        if (line === '.') {
          messages.push({ from: session.from, to: [...session.to], data: data.join('\r\n'), secure: session.secure, user: session.authenticated });
          data = null; session.to = [];
          send('250 2.0.0 Queued');
        } else data.push(line.startsWith('..') ? line.slice(1) : line);
        return;
      }
      if (login) {
        if (login.step === 'user') { login.user = Buffer.from(line, 'base64').toString(); login.step = 'pass'; send('334 UGFzc3dvcmQ6'); return; }
        const pass = Buffer.from(line, 'base64').toString(), user = login.user; login = null;
        if (auth && user === auth.user && pass === auth.pass) { session.authenticated = user; send('235 2.7.0 Authentication successful'); } else send(authFailure);
        return;
      }
      const [command, ...rest] = line.split(' '), verb = command.toUpperCase(), argument = rest.join(' ');
      if (verb === 'EHLO' || verb === 'HELO') {
        const lines = ['smtp.example.test'];
        if (starttls && !session.secure) lines.push('STARTTLS');
        if (mechanisms && session.secure) lines.push(`AUTH ${mechanisms}`);
        lines.push('8BITMIME');
        lines.forEach((value, index) => send(`250${index === lines.length - 1 ? ' ' : '-'}${value}`));
      } else if (verb === 'STARTTLS') {
        if (!starttls || session.secure) { send('502 5.5.1 STARTTLS not supported'); return; }
        send('220 2.0.0 Ready to start TLS');
        socket.removeAllListeners('data');
        const upgraded = new tls.TLSSocket(socket, { isServer: true, ...certificate() });
        socket = upgraded; session.secure = true; buffer = '';
        upgraded.on('data', receive);
        upgraded.on('error', () => {});
      } else if (verb === 'AUTH') {
        const [mechanism, payload] = argument.split(' '), name = mechanism.toUpperCase();
        if (!mechanisms || !session.secure) { send('503 5.5.1 AUTH not available'); return; }
        if (name === 'XOAUTH2' && oauth) {
          const decoded = Buffer.from(payload ?? '', 'base64').toString();
          xoauth2.push(decoded);
          if (decoded === `user=${oauth.user}\x01auth=Bearer ${oauth.token}\x01\x01`) { session.authenticated = oauth.user; send('235 2.7.0 Accepted'); } else send(authFailure);
        } else if (name === 'PLAIN' && auth) {
          const decoded = Buffer.from(payload ?? '', 'base64').toString().split('\0');
          if (decoded[1] === auth.user && decoded[2] === auth.pass) { session.authenticated = auth.user; send('235 2.7.0 Authentication successful'); } else send(authFailure);
        } else if (name === 'LOGIN' && auth) { login = { step: 'user', user: '' }; send('334 VXNlcm5hbWU6'); } else send('504 5.5.4 Unknown mechanism');
      } else if (verb === 'MAIL') { session.from = argument.replace(/^FROM:\s*/i, ''); send('250 2.1.0 OK'); }
      else if (verb === 'RCPT') {
        const address = argument.replace(/^TO:\s*/i, '').replace(/[<>]/g, '').split(' ')[0];
        if (rejectRecipients.includes(address)) send(`${rejectCode} ${rejectCode >= 500 ? '5' : '4'}.1.1 Recipient rejected`);
        else { session.to.push(address); send('250 2.1.5 OK'); }
      } else if (verb === 'DATA') { data = []; send('354 End data with <CR><LF>.<CR><LF>'); }
      else if (verb === 'RSET') { session.to = []; send('250 2.0.0 OK'); }
      else if (verb === 'NOOP') send('250 2.0.0 OK');
      else if (verb === 'QUIT') { send('221 2.0.0 Bye'); socket.end(); }
      else send('500 5.5.2 Unknown command');
    };
    function receive(chunk) {
      buffer += chunk.toString('utf8');
      let index;
      while ((index = buffer.indexOf('\r\n')) >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 2); lineHandler(line); }
    }
    socket.on('data', receive);
    socket.on('error', () => {});
    send('220 smtp.example.test ESMTP fake');
  };
  const server = implicitTls ? tls.createServer(certificate(), socket => handle(socket, true)) : net.createServer(socket => handle(socket, false));
  server.on('tlsClientError', () => {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, messages, sessions, xoauth2, close: () => new Promise(resolve => server.close(() => resolve())) };
}
