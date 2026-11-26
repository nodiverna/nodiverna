// TCP forwarder inside the browser container (e2e/compose.yaml), Node only, no
// dependencies. Chromium opens exactly BASE_URL (https://localhost:<port>), so
// host, Origin, SNI and __Host- cookies match SITE_ORIGIN. This process listens
// on 127.0.0.1:<port> in the container and passes every byte to the same port
// on the Docker host (host.docker.internal), or to E2E_APP_UPSTREAM=<host>:<port>.
import net from 'node:net';
import {realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

/** Listen on listenHost:listenPort and pipe each connection to upstreamHost:upstreamPort. close() also drops open connections. */
export function startForward({listenHost = '127.0.0.1', listenPort, upstreamHost, upstreamPort}) {
  const sockets = new Set();
  const server = net.createServer({allowHalfOpen: true}, client => {
    const upstream = net.connect({host: upstreamHost, port: upstreamPort, allowHalfOpen: true});
    sockets.add(client);
    sockets.add(upstream);
    const drop = () => {
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };
    client.on('error', drop).on('close', drop);
    upstream.on('error', drop).on('close', drop);
    client.pipe(upstream);
    upstream.pipe(client);
  });
  const close = server.close.bind(server);
  server.close = callback => {
    close(callback);
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    return server;
  };
  server.listen(listenPort, listenHost);
  return server;
}

/** host:port from E2E_APP_UPSTREAM, or host.docker.internal with the app port. */
export function upstreamFrom(env) {
  const port = Number(env.E2E_APP_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('E2E_APP_PORT must be the port of BASE_URL.');
  const override = env.E2E_APP_UPSTREAM?.trim();
  if (!override) return {listenPort: port, upstreamHost: 'host.docker.internal', upstreamPort: port};
  const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(override);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) throw new Error(`E2E_APP_UPSTREAM must be <host>:<port>: ${override}`);
  return {listenPort: port, upstreamHost: match[1].replace(/^\[|\]$/g, ''), upstreamPort: Number(match[2])};
}

const direct = process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (direct) {
  const target = upstreamFrom(process.env);
  const server = startForward({listenHost: '127.0.0.1', ...target});
  server.on('listening', () => console.log(`forward 127.0.0.1:${target.listenPort} -> ${target.upstreamHost}:${target.upstreamPort}`));
  server.on('error', error => {
    console.error(`forward failed: ${error.message}`);
    process.exit(1);
  });
}
