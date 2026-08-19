import * as net from 'net';
import { probeSocks5 } from '../vpnTunnel';

// Port 0 everywhere: the OS hands back a free ephemeral port, so these tests
// never collide with a real service or flake on a busy machine.
function listen(handler: (socket: net.Socket) => void): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function portOf(server: net.Server): number {
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('expected an AddressInfo, got a pipe/unset address');
  }
  return address.port;
}

// Every scenario the probe has to survive: a real SOCKS5 reply, a wrong
// version, a refused auth method, silence, an immediate close, and a reply
// split mid-handshake.
const scenarios: Array<[string, (socket: net.Socket) => void]> = [
  ['answers a proper SOCKS5 greeting', socket => socket.on('data', () => socket.write(Buffer.from([0x05, 0x00])))],
  ['replies with the wrong version', socket => socket.on('data', () => socket.write(Buffer.from([0x04, 0x00])))],
  ['refuses every offered auth method', socket => socket.on('data', () => socket.write(Buffer.from([0x05, 0xff])))],
  ['accepts and stays silent', socket => {
    // Resume (but ignore) input so the OS-level close from the probe's own
    // timeout teardown is actually observed -- an unread socket never sees
    // it, which would otherwise stall this test's own cleanup, not the probe.
    socket.resume();
  }],
  ['closes the connection immediately', socket => socket.destroy()],
  ['sends one byte then stalls', socket => socket.on('data', () => socket.write(Buffer.from([0x05])))],
];

describe('probeSocks5', () => {
  let servers: net.Server[] = [];

  async function startServer(handler: (socket: net.Socket) => void): Promise<net.Server> {
    const server = await listen(handler);
    servers.push(server);
    return server;
  }

  afterEach(async () => {
    await Promise.all(
      servers.map(server => new Promise<void>(resolve => server.close(() => resolve())))
    );
    servers = [];
  });

  test('resolves true for a server that answers a proper SOCKS5 greeting', async () => {
    const server = await startServer(socket => socket.on('data', () => socket.write(Buffer.from([0x05, 0x00]))));
    await expect(probeSocks5(portOf(server))).resolves.toBe(true);
  });

  test('resolves false for a server that replies with the wrong version', async () => {
    const server = await startServer(socket => socket.on('data', () => socket.write(Buffer.from([0x04, 0x00]))));
    await expect(probeSocks5(portOf(server))).resolves.toBe(false);
  });

  test('resolves false for a SOCKS5 server that refuses every offered auth method', async () => {
    // 0x05 0xFF is a real SOCKS5 server, but one that will not take our
    // no-auth offer -- and ours always does. It is therefore not our tunnel.
    const server = await startServer(socket => socket.on('data', () => socket.write(Buffer.from([0x05, 0xff]))));
    await expect(probeSocks5(portOf(server))).resolves.toBe(false);
  });

  test('resolves false for a malformed port instead of rejecting', async () => {
    // These reach the probe from a marker file, which is just JSON on disk: a
    // truncated write or a hand-edit can leave a negative, fractional or NaN
    // port behind. net.connect() validates the port synchronously and throws,
    // so without a guard the throw would escape as a rejected promise from a
    // call site that only ever handles a boolean.
    for (const port of [-1, 70000, NaN, 1.5, 0]) {
      await expect(probeSocks5(port, 50)).resolves.toBe(false);
    }
  });

  test('resolves false for a server that accepts and says nothing (times out)', async () => {
    const server = await startServer(socket => {
      // See the shared scenario list above for why resume() is needed here.
      socket.resume();
    });
    const started = Date.now();
    await expect(probeSocks5(portOf(server), 50)).resolves.toBe(false);
    // Sanity check it actually waited for the timeout rather than bailing early.
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
  });

  test('resolves false for a closed port', async () => {
    // Briefly listen on port 0 to obtain a genuinely free port, then close it
    // before probing so nothing is listening -- no fixed port number needed.
    const server = await listen(() => {
      /* never accepts; closed before the probe runs */
    });
    const port = portOf(server);
    await new Promise<void>(resolve => server.close(() => resolve()));
    await expect(probeSocks5(port)).resolves.toBe(false);
  });

  test('resolves false for a server that closes immediately', async () => {
    const server = await startServer(socket => socket.destroy());
    await expect(probeSocks5(portOf(server))).resolves.toBe(false);
  });

  test('resolves false for a server that sends one byte then stalls', async () => {
    const server = await startServer(socket => socket.on('data', () => socket.write(Buffer.from([0x05]))));
    await expect(probeSocks5(portOf(server), 50)).resolves.toBe(false);
  });

  test('never rejects, for any of the above scenarios', async () => {
    for (const [, handler] of scenarios) {
      const server = await startServer(handler);
      await expect(probeSocks5(portOf(server), 50)).resolves.toEqual(expect.any(Boolean));
    }
  });

  test('closes its socket on every path (no leaked handles)', async () => {
    for (const [, handler] of scenarios) {
      let closeSocket: () => void = () => undefined;
      const closed = new Promise<void>(resolve => {
        closeSocket = resolve;
      });
      const server = await startServer(socket => {
        socket.once('close', () => closeSocket());
        handler(socket);
      });
      await probeSocks5(portOf(server), 50);
      // If the probe left the socket open, this either times out (the test
      // fails) or, in the accept-and-close-immediately case, never gets far
      // enough to matter -- either way a leak surfaces here.
      await closed;
    }
  });
});
