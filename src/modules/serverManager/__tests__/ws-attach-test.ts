import * as http from 'http';
import { AddressInfo } from 'net';
import { WebSocket } from 'ws';
import { attachWs, WsHandle } from '../wsServer';

// These tests drive a REAL http.Server and a real `ws` client, because the
// properties under test are exactly the ones a pure unit test cannot see:
// that a rejected upgrade never becomes a 101, and that a disposed server
// genuinely takes a live socket away rather than politely waiting for it.
// The listener always binds port 0 on loopback.

const GOOD = 'good-token';

interface Harness {
  server: http.Server;
  ws: WsHandle;
  port: number;
  accepted: WebSocket[];
}

function start(opts: { onTerminal?: (ws: WebSocket) => void } = {}): Promise<Harness> {
  const accepted: WebSocket[] = [];
  const server = http.createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  const ws = attachWs(server, {
    hasToken: token => token === GOOD,
    onTerminal: socket => {
      accepted.push(socket);
      if (opts.onTerminal) {
        opts.onTerminal(socket);
      }
    },
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, ws, port: (server.address() as AddressInfo).port, accepted });
    });
  });
}

function stop(h: Harness): Promise<void> {
  h.ws.close();
  return new Promise(resolve => h.server.close(() => resolve()));
}

// Resolves 'open' if the handshake completed, or 'rejected' if it did not.
// A rejected upgrade must never reach 'open': `ws` reports the HTTP response
// as an 'unexpected-response'/'error' instead.
function connect(h: Harness, query: string): Promise<{ outcome: string; client: WebSocket }> {
  const client = new WebSocket(`ws://127.0.0.1:${h.port}/ws/terminal${query}`);
  return new Promise(resolve => {
    client.on('open', () => resolve({ outcome: 'open', client }));
    client.on('unexpected-response', (_req, res) =>
      resolve({ outcome: `status:${res.statusCode}`, client })
    );
    client.on('error', () => resolve({ outcome: 'error', client }));
  });
}

describe('attachWs', () => {
  it('destroys a bad-token upgrade without ever completing the handshake', async () => {
    const h = await start();
    const { outcome, client } = await connect(h, '?t=wrong');
    expect(outcome).toBe('status:401');
    expect(h.accepted).toHaveLength(0);
    client.terminate();
    await stop(h);
  });

  it('destroys an upgrade to an unknown path with 403', async () => {
    const h = await start();
    const client = new WebSocket(`ws://127.0.0.1:${h.port}/ws/nope?t=${GOOD}`);
    const outcome = await new Promise<string>(resolve => {
      client.on('open', () => resolve('open'));
      client.on('unexpected-response', (_req, res) => resolve(`status:${res.statusCode}`));
      client.on('error', () => resolve('error'));
    });
    expect(outcome).toBe('status:403');
    client.terminate();
    await stop(h);
  });

  it('accepts a good upgrade and hands it to the terminal handler', async () => {
    const h = await start();
    const { outcome, client } = await connect(h, `?t=${GOOD}`);
    expect(outcome).toBe('open');
    expect(h.accepted).toHaveLength(1);
    client.terminate();
    await stop(h);
  });

  // The point of the whole register: http.Server#close() does not touch an
  // upgraded socket, and WebSocketServer#close() in noServer mode removes
  // listeners and waits rather than terminating anyone. If close() only did
  // those two things this test would hang until its timeout.
  it('TERMINATES a live socket on close(), rather than waiting for it', async () => {
    const h = await start();
    const { outcome, client } = await connect(h, `?t=${GOOD}`);
    expect(outcome).toBe('open');

    const clientClosed = new Promise<void>(resolve => client.on('close', () => resolve()));
    const serverSideClosed = new Promise<void>(resolve =>
      h.accepted[0].on('close', () => resolve())
    );
    h.ws.close();
    await Promise.all([clientClosed, serverSideClosed]);

    await new Promise<void>(resolve => h.server.close(() => resolve()));
  });

  it('terminates only the named session on closeToken()', async () => {
    const h = await start();
    const first = await connect(h, `?t=${GOOD}`);
    expect(first.outcome).toBe('open');

    const closed = new Promise<void>(resolve => h.accepted[0].on('close', () => resolve()));
    h.ws.closeToken('some-other-token');
    // Still open: nothing matched that token.
    expect(h.accepted[0].readyState).toBe(WebSocket.OPEN);

    h.ws.closeToken(GOOD);
    await closed;

    first.client.terminate();
    await stop(h);
  });

  it('forgets a socket that closed on its own, so close() has nothing to do', async () => {
    const h = await start();
    const { client } = await connect(h, `?t=${GOOD}`);
    const serverSideClosed = new Promise<void>(resolve =>
      h.accepted[0].on('close', () => resolve())
    );
    client.close();
    await serverSideClosed;

    expect(() => h.ws.close()).not.toThrow();
    await new Promise<void>(resolve => h.server.close(() => resolve()));
  });

  // `ws` installs no default 'error' listener, and an 'error' with no
  // listener is an uncaught throw. A frame with a reserved bit set is enough
  // to make the receiver emit one.
  it('survives a protocol-error frame on an accepted socket', async () => {
    const h = await start();
    const { client } = await connect(h, `?t=${GOOD}`);
    const serverSideClosed = new Promise<void>(resolve =>
      h.accepted[0].on('close', () => resolve())
    );
    // RSV1 set with no extension negotiated: a protocol error.
    (client as any)._socket.write(Buffer.from([0xc1, 0x00]));
    await serverSideClosed;

    client.terminate();
    await stop(h);
  });
});
